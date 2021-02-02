---
layout: post
title:  "Associated types: What are they good for?"
subtitle: "an honest inquiry"
date:   2018-04-22 15:00:00 -0500
categories: rust frunk question
---

So I figured I'd finally try out that whole "blogging" thing.

...actually, that's a lie.  I just wrote up a really big topic to post on users.rust-lang.org,
and then once it crossed critical mass I just slapped some YAML frontmatter on it and stuck it
into the `_posts` directory of "that GitHub pages thing I almost set up last year"
for a monumental first post.[^another-lie]

[^another-lie]: Actually, that's another lie.  It took me another 7 hours to figure out enough about Jekyll, ruby gems, GitHub pages, and CSS to make it presentable, all of which I will forget by tomorrow morning.

I don't have any sort of comment system set up here (yet).
Instead, you can reply to [this URLO thread](https://users.rust-lang.org/t/associated-types-what-are-they-good-for/17016).

---

I am aware of the distinction between how associated types and type parameters *should* be used:

- Use a **type parameter** when a trait could conceivably be implemented multiple times by the same struct with different types for that type parameter.
- Use an **associated type** when the type is *determined by* the other type parameters.

but when you really get down to it, it seems the real distinction is a lot more subtle.  In fact, [frunk](https://github.com/lloydmeta/frunk) often uses type parameters in places where *ideally* one would expect it to use associated types (I'll get to that, soon).

Here's some surprising (and discouraging) facts about associated types:

## Surprising facts about associated types

### **Fact 1:** Disjoint associated type equality bounds still "overlap!"

Many dreams have been crushed when trying to write something like this, which is no doubt the single most obvious use case for associated types:

```rust
trait Bound { type Assoc; }
trait Trait { }

// rustc forbids this; it is not yet sophisticated enough to recognize the fact
// that these impls do not overlap!
impl<T> Trait for T where T: Bound<Assoc=i16> { }
impl<T> Trait for T where T: Bound<Assoc=u16> { }
```

There is a [postponed RFC](https://github.com/rust-lang/rfcs/pull/1672) to improve this. Perhaps it will be revisited one day after the integration of chalk into rustc.  Until then, all we can do is dream.

### **Fact 2:** Associated types can be simulated with type inference

**(a.k.a. _what on Earth_ is up with frunk's `Index` parameters?)**


I mentioned earlier that frunk often uses type parameters for things that seem like they *ought* to be associated types.   The easiest way to understand why, however, is to try it out yourself.[^frunk-story] Consider the HList type, representing a heterogenous fixed-length sequence of elements as `HCons<A, HCons<B, HCons<C, HNil>>>`:


[^frunk-story]: This is basically the story of why I am now contributing to frunk.  I thought I could do it better... and I discovered that I could not.


```rust
pub struct HNil;
pub struct HCons<Head, Tail>(pub Head, pub Tail);
```

Implementing traits for HLists generally involves some form of type-level recursion.  For those unfamiliar with the idea, frunk owner lloydmeta has [written about this](https://beachape.com/blog/2017/03/12/gentle-intro-to-type-level-recursion-in-Rust-from-zero-to-frunk-hlist-sculpting) as well.  Generally speaking, it requires at least two impls:

- The **base case;** often this is an impl for `HNil`, but sometimes it may be an impl for `HCons` whose `Head` satisfies a particular constraint.
- The **recursive case;** this extends the trait to lists of arbitrary length.  It is typically an impl of the form
  ```rust
  impl<Head, Tail> Trait for HCons<Head, Tail>
  where Tail: Trait,
  { ... }
  ```

If you have never done this before, I invite you to try an exercise: **Try implementing the following trait for HLists.**[^const]

[^const]: Yes, I know I could have written this using an associated const.  Please contain your excitement.

```rust
pub struct HNil;
pub struct HCons<Head, Tail>(pub Head, pub Tail);

/// Get the length of an HList.
pub trait Len {
    fn len(&self) -> usize;
}
```

Alright, go do it.  Don't worry, this one's easy.  I can wait.

...

...did you do it? Excellent!!  Or, wait a second... did you *really* do it, or are you just saying that? *Cmon, I'm trying to make a point here!*  Look, [here's a playground](https://play.rust-lang.org/?gist=950c2be4676eda5509eaaf8eb41483a6&version=stable) to start you off. It even comes with unit tests, free of charge! So go write those impls.

...what's that?  You're on your phone and it's difficult to type?  *Then click the gear in the top right corner of the playground and change the editor to "Simple!!" Aaaaaaaghh!!!!*

...okay.  I'm just going to assume you did it.  Look at you, already a black-belt in type-level recursion!! おめでとうございます!!  As mentioned above, you should have two impls; a base case for `HNil`, and a recursive case for `HCons`. And with that exercise under your belt, here's one that's a bit tougher.

```rust
/// Borrow the first value of type T in an HList.
pub trait GetFirst<T> {
    fn get_first(&self) -> &T;
}
```

...and by a bit tougher, I mean *impossible.*  Seriously, **I challenge you to implement that trait.** As before, here's a [playground](https://play.rust-lang.org/?gist=97c9fe61386aa4bc8c2c849b68f8c60b&version=stable) with test cases. You are allowed to add as many associated types and helper traits as you see fit, but no type parameters.[^even-with-params] What happens, inevitably, is that at some point, you have two impls that look vaguely like this:

[^even-with-params]: Actually, I am pretty well convinced that it is impossible to implement this trait *even with extra type parameters*, under the restriction that the user must never need to enter these type parameters unless they can always write the same thing at all call sites for a fixed `T` (e.g. `<_ as GetFirst<T, (), _, HNil>>::get_first`).

```rust
// base case
impl<T, Tail> GetFirst<T> for HCons<T, Tail> { ... }
// recursive case
impl<T, U, Tail> GetFirst<T> for HCons<U, Tail> where Tail: GetFirst<T> { ... }
```

and these conflict in the special case where `T == U`.  If you've read lloydmeta's post ([here it is again](https://beachape.com/blog/2017/03/12/gentle-intro-to-type-level-recursion-in-Rust-from-zero-to-frunk-hlist-sculpting/)) you'll see that this is what happened to his first implementation of `pluck`.  In the end, we need to change the trait to something like this.

```rust
/// Borrow an element of type T from the HList.
///
/// Uhh. Just ignore that `Index` thing. It's an implementation detail, really.
/// If somehow forced to specify it in an expression-like context at gunpoint,
/// use `_` to infer it.
///
/// Oh, by the way, if your list happens to have multiple elements of type `T`,
/// you'll get a type inference error.  ...don't ask.
pub trait Get<T, Index> {
    fn get(&self) -> &T;
}

// Indices, or peano integers, basically. Don't ask.
pub struct Here;
pub struct There<N>(pub N);

// Thanks to Index, the impls clearly no longer overlap.
impl<T, Tail> Get<T, Here> for HCons<T, Tail> { ... }
impl<T, U, N, Tail> Get<T, There<N>> for HCons<U, Tail> where Tail: Get<T, N> { ... }
```

At first glance you might expect that all hope is lost; what's the point in having a method to find an element of type `T` if you also need to specify its index?!  But as it turns out, there is hope after all. This is where we finally come to the whole entire point of this exceptionally long subheading:[^essay]

> **Suprising fact:** You can leave this extraneous type parameter to type inference. The rust compiler will gladly infer the type of a type parameter wherever a **unique solution** for it exists.

In this case, a unique solution means that `T` is only contained once in the list, so that there is only a single valid value for `Index`.  Thankfully, this is not expected to be a great limitation in practice, because if you are using HList's type-directed indexing in a way such that this causes trouble, you should probably be wrapping your fields in newtypes anyways.[^effects]

[^effects]: Granted, I have read a paper on an [effect system in Haskell](https://www.cs.indiana.edu/~sabry/papers/exteff.pdf), which, if I understood correctly[^unlikely], requires at its foundation the ability to remove the most recently added instance of a specified type in a heterogenously-typed stack.  But come on, you're *not* using frunk to implement an effect system in rust. Not without HKTs, at least.

[^unlikely]: A phenomenally unlikely event.

**Fact:** The initial design of [`Coproduct::uninject`](https://docs.rs/frunk_core/0.2.0/frunk_core/coproduct/trait.CoprodUninjector.html) had a *type parameter* for the remainder rather than an associated type. Hardly anyone could even tell the difference; the remainder is always unique, so type inference can always solve for it.  I changed it to an associated type to prevent it from infecting the signatures of other things like [`Coproduct::subset`](https://docs.rs/frunk_core/0.2.0/frunk_core/coproduct/trait.CoproductSubsetter.html), but I am still uncertain as to whether this change conferred any actual *new capabilities.*

[^essay]: If this post were a five-paragraph essay, two of the body paragraphs would be one word long.

## So what *are* associated types good for today?

With the prior section in mind, what benefits *do* associated types provide over type parameters?  Here is the complete list I can come up with:

* **Cleaner type parameter lists:** They allow methods, traits, and impls to be written with fewer type parameters, and help reduce confusion over the roles each type parameter plays.
* **Implied bounds.** This one is kind of subtle, but: associated types are one of the few things that have implied bounds today.  If you write `type Assoc: Bound`, then the compiler understands that `<T as Trait>::Assoc: Bound` without you writing it.[^subtle]
* **Comfort in knowing that the API is usable.**  Even though you can simulate associated types with type parameters, it's up to you to make sure you do not introduce any ambiguities in your set of impls (which will manifest only as *very confusing inference errors* in downstream code).

This is alright, but as far as I can tell they don't make any new things possible. Which brings us to our final stop:
    
[^subtle]: Note this breaks down if you write something like `T: Trait<Assoc=U>` where `U` is a generic type parameter, as the compiler will then demand that you write `U: Bound` for the sake of, uh, *something something well-founded,* or idunno.  It's like I said: **_Subtle._**

## Why do I care?

There's a feature I've been considering adding to frunk that I frequently refer to as **reified indices,** though perhaps a more accurate name would be "index-directed lookup."

### What are reified indices?
Basically, take those poor, unloved indices that we keep telling the user not to worry about, and give them some love in the form of methods that produce and accept indices.  This can let you do things like "select the item of list B corresponding to the location of T in list A," which is useful for managing multiple HLists arranged in a structure-of-arrays style.

```rust
pub trait IndexOf<T, Index> {
    fn index_of(&self) -> Index;
}

pub trait GetAt<Index> {
    type Value;
    
    fn get_at(&self, idx: Index) -> &Self::Value;
}

// these are wrapped with inherent methods that support a turbofish,
// so that you basically use them like this:
let index = list_a.index_of::<i32, _>();
let b_item = list_b.get_at(index);
```

### Are they worth it?

Hey, *that's my line!*

The thing is, I've not yet been able to convince myself that they actually solve any problems. (granted, I haven't put much thought into it yet since I've been saving it for after frunk 0.2.0, which was just released yesterday).  To use this functionality in a generic context you'll still need to mention the indices in where bounds, so what's the difference whether you write `Bs: GetAt<I>` (and use `Bs::Value`) versus `Bs: Get<B, I>` (and let type inference infer `B`)?

The feature will require plenty of design work (e.g. should `GetAt` be a supertrait of `Get`? Or vice versa? Or neither?) and will result in a number of additional traits and methods for index-based lookup that parallel the existing methods for type-based lookup.  And in the end, it seems that their sole raison d'être will be to allow some type parameters to be replaced with associated types in certain circumstances.

If that's the case, *then those associated types had better be worth it!*

So that's why I am writing; I am simply not certain yet whether reified indices are worth the trouble.

<!-- FIXME should instead do this by sticking something into the `footnotes` div directly, through... hell, I dunno. JS? CSS? -->
## Fütnotes
