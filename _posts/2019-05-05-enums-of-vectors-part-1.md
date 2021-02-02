---
layout: post
title:  "Enums of Vectors, Part 1: The macro solution"
date:   2019-05-05 18:00:00 -0500
categories: rust series
---

This is partly a response to [this URLO thread](https://users.rust-lang.org/t/correct-way-to-extract-type-of-data-from-a-binary-file/27864)... and I'm also writing it up just so I can have something to link to later.

I kind of just threw this together in a couple of hours.  I thought I would get to more crazy things like generic `map` functions, but I kinda ran out of time after barely finishing writing about macros.

---

I am fairly strongly of the opinion that Rust lends itself well to the data-oriented "struct of arrays" approach to design, far better than to the more object-oriented "array of structs" design.  The data-oriented design is most amenable to changes in program flow, and are almost always a better fit for the borrow checker.  The advantage of this design is particularly apparent for things like `Option<Vec<T>>`.  I would never want to find myself carrying around a container of `Foo`s that each have a `thing: Option<Thing>` field, where either all of the `thing`s are `Some` or all of them are `None`.

Fortunately, `Option<T>` is a simple type, and with `.as_ref()`, `.as_mut()`, `.map()`, and `match`[^map-or-else], we have virtually everything we could wish for.  But some types are more complicated.  Structs of arrays are great, but like anything else, they are no silver bullet, and there are times when they are dreadful to work with.[^probably-still-easier]

[^map-or-else]: The Haskell writer in me is tempted to write [`map_or_else`](https://doc.rust-lang.org/std/option/enum.Option.html#method.map_or_else) here, which is the closest thing in spirit to Haskell's `maybe` function, and the closest thing to the `fold` macro I'll be introducing.  But I almost never use `map_or_else` in favor of `match`.

[^probably-still-easier]: Probably still easier than working with arrays of structs.

Let's say we have the following data type:

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum Data {
    Integer(Vec<i32>),
    Real(Vec<f64>),
    Complex(Vec<(f64, f64)>),
}
```

This is a vector with an unknown element type, and we want to do various operations on it (e.g. get its length, or the first element) without knowing which variant is inside, and we don't want to have to write long, repetitive `match` statement every time.

There's a large number of approaches we can take here, from macros to generic types to generic traits.  Each step we take allows us to solve more problems at the cost of a number of inconveniences.  Be prepared to face many hardships along the way.  Some of these are due to language limitations, which may be lifted in the future:

* Closures cannot be generic
* Rust has no higher kinded types

Other hardships are simply due to the nature of the problem we're trying to solve.

## The Duck-Typing Solution

The easiest way to solve this problem is with macros.

### Folding

If we only ever need to produce simple things like a `usize` or `bool`, here's one way:

```rust
macro_rules! fold_data {
    ($data:expr, $f:expr $(,)?) => {
        match $data {
            $crate::Data::Integer(v) => $f(v),
            $crate::Data::Real(v) => $f(v),
            $crate::Data::Complex(v) => $f(v),
        }
    }
}
```

That let's us call functions like `len()` that don't involve the values of the vector.

```rust
#[test]
fn test_fold() {
    let data = Data::Real(vec![1.0, 3.0]);

    assert_eq!(fold_data!(&data, |v| v.len()), 2);
    assert_eq!(fold_data!(&data, |v| v.is_empty()), false);

    // You can work with the values as long as you convert them into some common type
    assert_eq!(fold_data!(&data, |v| format!("{:?}", v[0])), "1.0");

    // You can also move data
    assert_eq!(fold_data!(data, |v| v.into_iter().count()), 2);
}
```

Notice how we can call `fold_data!` with `&data`.  This takes advantage of `match` ergonomics; in these cases the macro expands to `match &data { ... }`, and the `v` bindings in the match arms are given type `&Vec<_>`.

#### Improving type inference

If you try to use the above, you'll find it doesn't actually compile, as rustc cannot infer the type of `v` in the closures in the test!  This is because when Rust tries to typecheck `$f(v)`, it tries to type-check `$f` before looking at its argument `v`.

*But that's strange,* you might say; *I've never had that sort of problem when using `Iterator::map`!*

Indeed.  That's because Rust's type inference contains a hack:  When a method is called, rust checks the `Self` type *before* it checks the closure, and unifies the types of the closure's formal parameters with any `Fn` trait bounds it sees on the method.  Thanks to this, our problem mostly only ever pops up in macros.

In practice, all of this just means we have to rewrite the function calls as method calls:

```rust
#[macro_export]
macro_rules! fold_data {
    ($data:expr, $f:expr $(,)?) => {
        match $data {
            Data::Integer(v) => $crate::InferenceHelper(v).call_fn($f),
            Data::Real(v) => $crate::InferenceHelper(v).call_fn($f),
            Data::Complex(v) => $crate::InferenceHelper(v).call_fn($f),
        }
    }
}

/// Allows `$f(v)` in a macro to be written as a method call,
/// to improve type inference when `$f` is a closure expression.
#[doc(hidden)]
pub struct InferenceHelper<T>(pub T);

impl<T> InferenceHelper<T> {
    #[inline(always)]
    pub fn call_fn<R>(self, function: impl FnOnce(T) -> R) -> R {
        function(self.0)
    }
}
```

### Mapping

Let's say you want to get something from the vector that involves the element type. **E.g.** *I want the first element of the vector.*

Let's take the following strawman example:

```rust
fn wont_work() {
    let int_data = Data::Integer(vec![1, 2, 3]);
    let real_data = Data::Real(vec![1.0, 2.0, 3.0]);
    
    assert_eq!(fold_data!(&int_data, |v| v[0]), 1);
    assert_eq!(fold_data!(&real_data, |v| v[0]), 1.0);
}
```

This won't compile because the folds expand to something like this: (after some inlining and simplification)

```rust
match &int_data {
    Data::Integer(v) => v[0], // an i32
    Data::Real(v) => v[0],    // an f64
    Data::Complex(v) => v[0], // a (f64, f64)
}
```

Whoops!  *The match arms have different types!*  If you've found yourself writing something like the above, it is more likely that you meant to do one of two things:

**(a):** You already know which variant it ought to be.  In this case, you can write a `match` because you only need two branches:

```rust
let first = match &int_data {
    Data::Integer(v) => v[0],
    _ => panic!("wrong variant"),
};
assert_eq!(first, 1);
```

**(b):** It really could be any variant, in which case you clearly need to return an enum.

Here's where things start to get a little bit ugly.  To enable the widest range of applications, we need to make `Data` generic.

```rust
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Data<
    INTEGER = Vec<i32>,
    REAL = Vec<f64>,
    COMPLEX = Vec<(f64, f64)>,
> {
    Integer(INTEGER),
    Real(REAL),
    Complex(COMPLEX),
};

#[macro_export]
macro_rules! map_data {
    ($data:expr, $f:expr $(,)?) => {
        match $data {
            $crate::Data::Integer(v) => $crate::Data::Integer($crate::InferenceHelper(v).call_fn($f)),
            $crate::Data::Real(v) => $crate::Data::Real($crate::InferenceHelper(v).call_fn($f)),
            $crate::Data::Complex(v) => $crate::Data::Complex($crate::InferenceHelper(v).call_fn($f)),
        }
    }
}

#[test]
fn test_map() {
    let int_data: Data = Data::Integer(vec![1, 3]);
    let real_data: Data = Data::Real(vec![1.0, 3.0]);

    assert_eq!(map_data!(&int_data, |v| v[0]), Data::Integer(1));
    assert_eq!(map_data!(&real_data, |v| v[0]), Data::Real(1.0));
}
```

We also now had to annotate the locals in the test as `Data` so that the `Vec` defaults are inferred for the other, unused variants of `Data`.

#### Working with two things of the same variant

Working with `map` invariably puts us in situations where two different objects are known to have the same variant.  For instance, suppose that, we wanted to count the number of times that the first element appears anywhere in the sequence.  If we want to accomplish this in terms of a separate map and a fold, the single most useful tool to us would be the following:

```rust
/// Combines two `Data`s into a `Data` holding a tuple if they have the same variant.
pub fn zip<
    INTEGER_1, REAL_1, COMPLEX_1,
    INTEGER_2, REAL_2, COMPLEX_2,
>(
    data_1: Data<INTEGER_1, REAL_1, COMPLEX_1,>,
    data_2: Data<INTEGER_2, REAL_2, COMPLEX_2,>,
) -> Result<
    Data<
        (INTEGER_1, INTEGER_2),
        (REAL_1, REAL_2),
        (COMPLEX_1, COMPLEX_2),
    >,
    VariantError,
> {
    let tag_1 = data_1.tag();
    let tag_2 = data_2.tag();
    let err = || VariantError::new(tag_1, tag_2);

    match data_1 {
        Data::Integer(a) => match data_2 {
            Data::Integer(b) => Ok(Data::Integer((a, b))),
            _ => Err(err()),
        },
        Data::Real(a) => match data_2 {
            Data::Real(b) => Ok(Data::Real((a, b))),
            _ => Err(err()),
        },
        Data::Complex(a) => match data_2 {
            Data::Complex(b) => Ok(Data::Complex((a, b))),
            _ => Err(err()),
        },
    }
}
```

Some notes:
* This is only our first `fn` and already the signatures are **terrifying.**  We need to do something about this soon!
* The nested match could be compressed into one match on `(data_1, data_2)`, but I wrote it this way so that it stops compiling when a new variant is added (rather than falsely taking a `_` branch).

There's also an error type here.  I figured that `Data<(), (), ()>` serves as a convenient way to carry the tag of some data without having to hold the data.  `VariantError` is just a custom error type holding two such tags, and I have chosen to use the `failure` crate to give it some niceties.  (I didn't say my code here would be minimal!)

```rust
use std::fmt;

#[macro_use]
extern crate failure;

pub type DataTag = Data<(), (), ()>;

impl<INTEGER, REAL, COMPLEX> Data<INTEGER, REAL, COMPLEX> {
    pub fn tag(&self) -> DataTag {
        map_data!(self, |_| ())
    }

    fn variant_name(&self) -> &'static str {
        match self {
            Data::Integer(_) => "Integer",
            Data::Real(_) => "Real",
            Data::Complex(_) => "Complex",
        }
    }
}

#[derive(Debug, Fail)]
pub struct VariantError {
    pub lhs: DataTag,
    pub rhs: DataTag,
    #[fail(backtrace)]
    backtrace: failure::Backtrace,
}

impl VariantError {
    pub fn new(lhs: DataTag, rhs: DataTag) -> Self {
        VariantError {
            lhs, rhs,
            backtrace: failure::Backtrace::new(),
        }
    }
}

impl fmt::Display for VariantError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f,
            "Mismatched Data variants: {} vs {}",
            self.lhs.variant_name(),
            self.rhs.variant_name(),
        )
    }
}
```

Here's how you can use `zip`:

```rust
#[test]
fn test_zip() -> Result<(), failure::Error> {
    let data: Data = Data::Real(vec![1.0, 3.0, 1.0]);
    let first = map_data!(&data, |v| v[0]);

    let count = fold_data!(
        zip(data, first)?,
        |(data, first)| data.into_iter().filter(|&x| x == first).count(),
    );
    assert_eq!(count, 2);
    Ok(())
}
```

#### `as_ref` and `as_mut`

In the above test, `data` was moved into the call to `zip`.  Unlike `map_data!` and `fold_data!` earlier, `zip` is not a macro, so we cannot just write `&data` and hope for match ergonomics to take care of us.

If we wanted to borrow `data` instead, we need some more functions.

```rust
impl<INTEGER, REAL, COMPLEX> Data<INTEGER, REAL, COMPLEX> {
    pub fn as_ref(&self) -> Data<&INTEGER, &REAL, &COMPLEX> {
        map_data!(self, |x| x) // abuse match ergonomics
    }

    pub fn as_mut(&mut self) -> Data<&mut INTEGER, &mut REAL, &mut COMPLEX> {
        map_data!(self, |x| x)
    }
}

#[test]
fn test_zip() -> Result<(), failure::Error> {
    let data: Data = Data::Real(vec![1.0, 3.0, 1.0]);
    let first = map_data!(&data, |v| v[0]);

    let count = fold_data!(
        zip(data.as_ref(), first)?,
        |(data, first)| data.iter().filter(|&&x| x == first).count(),
    );
    assert_eq!(count, 2);
    Ok(())
}
```

Ahhhhh. That's better.

## Going further

If you want to avoid macros and do everything within the type system, things are going to get a lot harder.  Clearly, this system of writing out `N` type parameters for `Data` every time is not going to scale!

Unfortunately, solving that requires one of the most insane hacks you can do in Rust today, which is to (attempt to!) simulate functors using type families.  It'll be significantly harder to maintain, and harder to use as well, because you'll no longer be able to use the `Fn` traits (and thus you lose Rust's sugar for closures).

I'll get to that later.

## Footnotes
