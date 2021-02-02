---
layout: post
title:  "Lockout, Part 2: And nary a function to be found"
date:   2018-09-18 14:00:00 -0500
categories: rust series
# used for ToC generation
series: lockout
series-part-id: 2
---

This is part of a blog series on working towards an intuitive mental model for lifetimes in Rust.

{% include series/lockout-toc.html %}

---

**Soooo...** I wanted to avoid talking about this.  I *really, really, wanted to avoid this.*  I didn't want to have to define terms like "place" or... (*ahem*) "value."

But when I tried to sit myself down and really, really write down an in-depth example... I realized that there was no two ways about it.  __Before you can learn to appreciate why lifetimes exist, you must learn what life would be like without them.__ And in order to do that, well...

...you see, trying to simply picture rust without lifetimes is not easy, because it is ultimately the borrow checker that cares about them.  And the borrow checker is really not something you or I think about on a daily basis.

So let's come up with our _own_ borrow checker; the simplest one we can, in order to explore this crazy, new world without lifetimes!

## A very basic borrow checker

### Ground rules

The borrow checker is primarily concerned about the goings-on in a single function's body.  Following what many agree to be a core tenet of Rust, this ought to be **a purely local analysis,** and should not require looking beyond the signature of another function in order to decide what impact it has on borrow-checking.

We want the design to be fairly basic and introduce a minimum of new concepts.  What it comes down to is that there are two key concepts that we'll want to introduce: *Lockables,* and *locks.*

Let's get these new bits of terminology out of the way:

### A lockable is a nameable location that you can borrow, read, or write

```rust
fn area(rect: &Rect) -> i64 {
    rect.height * rect.width
}
```

The above example---short as it is---has four lockables we can name:

* `rect`: A lockable of type `&Rect`
* `*rect`: A lockable of type `Rect`
* `(*rect).height` and `(*rect).width`: Lockables of type `i64`

Lockables are, well... basically lvalues.  For our purposes, though, we're not particularly interested in all lvalues, just ones that we can easily check borrows of.  For instance, `vec[i]` is an lvalue, but it is too difficult to tell statically if `vec[i]` and `vec[j]` are the same; so we only bother talking about the entire `vec`.

**For now, our borrow checker is going to be pretty dumb and will only care about one type of lockable:**[^one-item]

* `local`: A local variable mentioned by name.[^upvar]

This is very coarse grained, and trying to borrow a field of a struct will borrow *the whole thing.* This just makes life a tad easier, so that it doesn't take us so long to finally reach the part about lifetimes!

[^one-item]: Yes, that's a list with one item. This post used to consider fields as well, but it just isn't worth it.

[^upvar]: I think that *technically*, when a closure closes over a local, then mentions of the local inside the closure will need to refer to a *separate* lockable (representing a field on the closure's anonymous struct) in order for our borrow checker to be happy.  I'm pretty sure Rustc does something like this too and calls them "upvars."  For now, we can dodge this subtlety by simply not writing any closures that capture things.

For now, I'm just going to state without justification that `statics`, `consts`, and `fns` (i.e. all "path expressions") are completely ignored by the borrow checker and therefore not lockable.

### Lockables may be locked for reading or writing

Various expressions in a function body may put **read locks** and/or **write locks** on lockables.  The borrow checker traces the existence of these locks along every possible control flow path through the function.  There is a single, core rule:

> **Borrow checking shall fail if---and only if---there exists a control flow path where a single lockable is simultaneously locked both for writing and for something else.**

What kinds of expressions create locks?  Well, obviously, borrowing does:

+ The expression `&vec` will lock `vec` for reading.
+ The expression `&mut vec` will lock `vec` for writing.
+ If `p` can be dereferenced, then `&*p` also locks `p` for reading.  (and etc. for `&mut *p`)

**These locks will be considered to be *held* by the borrow,** and they will only be released once the borrow is deinitialized. This is intended to approximate the behavior of the lexical borrow checker.

There's a few more things that can create locks:

* When a `&T` is copied or a `&mut T` is moved, the resulting borrow holds the same lock as the original.  (via refcounting)
* When a lockable is deinitialized, it is briefly locked for writting.
* Reading from a `Copy` lockable briefly locks it for reading.
* Reading from a `!Copy` lockable moves it; this counts as deinitializion, and thus briefly locks it for writing.
* All of the "brief" locks above are just safety tests, and are immediately released once taken.

Sounds reasonable, right?  Well, the devil is in the details---and there's a **lot** of details that we left out.  To discover what's wrong with our design, we'll need to...

## Experiment, learn, and iterate

### A miniature, boxy Rust without lifetimes

We'll be keeping ourselves to a pretty small set of toys for now; basically just `Box<T>`.

To delay the question of lifetimes, however, we're going to avoid function calls for now.  We will assume the following:

* We're going to pretend that **`Box::new(value)` is _not_ an opaque function call, but rather _magical special language syntax_ for constructing a literal `Box<T>`.** Think of it like struct literals and tuple literals.  The borrow checker is able to see right through it and give it special semantics if need be.[^boxbox]
* **These boxes can be dereferenced.**  As noted above, `&*p` is understood to borrow the lockable `p`; however, you can consider this to be due to language-level Mᴀɢɪᴄ!! rather than having anything to do with the signature of some funky old trait method somewhere called `deref`.

[^boxbox]: I guess you could say that `Box` and `new` are contextual keywords, or... whatever it takes for you to suspend your disbelief!  Early drafts of this blog post used `box x` (which I stopped using as people may think of "placement new"), or made up syntax like `Box { x }` (which I stopped using since I couldn't compile the examples to check for typos).  So... I'm going with "`Box::new` is magical," and that's that.

### A stupidly simple example

```rust
fn contrived(mut boxy: Box<bool>) {
    let borrow = &*boxy;
    boxy = Box::new(true);
    assert!(*borrow); // UB!
}
```

For its brevity, the above code makes a fair number of locks:

* The expression `&*boxy` creates a temporary `&bool` holding a read lock of `boxy`. It is copied into `borrow` (preserving the lock), and the temporary is deinitialized.
* On line 2, `boxy` is briefly locked for writing.
* On line 3, `borrow` is briefly locked for reading.
* At the closing brace, locals are deinitialized in reverse order of creation.
    * `borrow` is briefly locked for writing, then deinitialized, releasing the lock on `boxy`.
    * `boxy` is briefly locked for writing, then deinitialized.

We can visualize this; below, the vertical axis is control flow through the function, the blue box represents the read-lock held by `borrow`, and the blue and red lines represent briefly-acquired read- and write-locks.

<div class="figure light small"><img src="/assets/img/post/lockout/borrows-1.svg" /></div>

**Our borrow checker rejects this code because the write-lock of `boxy` created on line 2 conflicts with the existing read-lock held by `borrow`.**  Good.

### Reborrowing

```rust
fn reborrowing_is_totes_okay(mut boxy: Box<bool>) {
    let a = &mut boxy;
    let b = &mut *a;
    assert!(**b);
}
```

Hmm. This should be allowed... but is it?  Let's see:

* `a` holds a write-lock on `boxy`.
* `b` holds a write-lock on `a`.
* Line 3 briefly locks `b` for reading.
* At the closing brace, `b`, `a`, and `boxy` are deinitialized, in that order.

<div class="figure light small"><img src="/assets/img/post/lockout/i-suck-at-inkscape.svg" alt="I suck far too much at inkscape to make another one of those images."/></div>

No conflicts here!  It appears that, currently, reborrowing Just Works.™  Let's try to keep it that way!

### Locks held by other types

```rust
fn loophole() {
    let mut boxy = Box::new(false);
    let borrow = Box::new(&*boxy);
    boxy = Box::new(true);
    assert!(**borrow); // UB!
}
```

L-l-l...*`loophole`?*  Why is this one called `loophole`? Hmmmmm. In Line 2...

* `&*boxy` creates a read-lock on boxy.
* This temporary `&bool` is read to produce a `Box<&bool>`, which is stored in a local.
* The temporary `&bool` is deinitialized.
* ...and now there aren't any values with a `&` type anymore, so there couldn't possibly be anything that continues to hold a lock on `boxy`.  **The read-lock is (wrongly) released!**
* As a result, no problem is detected on Line 3.

Crap! If we want to continue with the notion that "values hold locks," then it looks like we need to adjust our base ruleset a bit.  It appears that types like `Box` need to be able to hold locks, too! Our rule is now the following:

> **A value[^value] of *any* type** (not just `&T` or `&mut T`!) **may hold read/write locks on lockables, which are released when the value is deinitialized.**


[^value]: Hm, gee, you probably need me to define "value," too, right?  Okay, it's, uh... how about.... it's any local that is initialized, and any expression in a function that could be perceived to exist at runtime.  Most expressions are values, but the `x` in `match x { ... }` and the `*x` in `&*x` are not.  That should do for now, I hope?

The precise rules for which values must hold which locks are something that we still need to work out, but we can tell this much:

* The expression `&p` (or `&*p`, etc.) holds a new read-lock of `p`.
* The expression `&mut p` (or `&mut *p`, etc.) holds a new write-lock of `p`.
* When a value is moved or copied, the new value holds any lock held by the original.
* **NEW:** `Box::new(value)` must hold whatever lock, if any, was held by `value`.

### A value may hold multiple locks

Let's step it up a notch further.

```rust
fn in_a_tuple() {
    let mut a = Box::new(0);
    let mut b = Box::new(0);
    let tuple = (&*a, &*b);

    // either of the following two lines should be equally bad
    a = Box::new(0);
    // b = Box::new(0);

    assert_eq!(tuple, (&0, &0));   // UB!
}
```

This is the same loophole as before, only now it is with tuples.  For the borrow checker to detect these conflicts, we should add the following rule:

* When constructing a product type via a tuple literal or struct literal, the result must hold **the union of all locks** formerly held by its fields.

And hey, while we're at it, how about sum types?

```rust
// an enum whose variants are non-tuple structs so that nobody can
// claim that I'm calling any functions :V
enum Either<L, R> {
    Left { value: L },
    Right { value: R },
}

fn in_an_either(use_left: bool) {
    let mut a = Box::new(0);
    let mut b = Box::new(0);
    let either = match use_left {
        true => Either::Left { value: &*a },
        false => Either::Right { value: &*b },
    };

    // either of the following two lines should be equally bad
    a = Box::new(0);
    // b = Box::new(0);

    // UB!
    assert_eq!(&0, match either {
        Either::Left { value } => value,
        Either::Right { value } => value,
    });
}
```

Just like `tuple`, it seems that `either` must hold read-locks of both `a` and `b`.

But... *well...* hang on a minute. I think we may have asked the wrong question here, because we don't actually need an `enum` in order to create this situation!

```rust
fn who_needs_enums(use_a: bool) {
    let mut a = Box::new(0);
    let mut b = Box::new(0);
    let borrow = match use_a {
        true => &*a,
        false => &*b,
    };

    // either of the following two lines should be equally bad
    a = Box::new(0);
    // b = Box::new(0);

    assert_eq!(&0, borrow); // UB!
}
```

As you can see, all we needed to create this situation was to have branches in control flow!

Technically speaking, our borrow checker as described should already be capable of handling this, because we've stated that it checks all control flow paths.  But let's face it;  you know it can't *really* do that, since the number of control flow paths can grow exponentially!

So we'll add another rule to make sure that borrow checking is actually tractable:

* When branching paths of control flow merge back together, values are effectively considered to hold the **union of all locks** that they would have held after each individual path.

Interestingly, this means that even a value of type `&i32` may now hold more than one lock!

### Borrowed arguments and return types

When a value is returned from a function, we'll say that it is simply copied/moved into a special "return register," where it won't be deinitialized.  With this clarification in tow, there's a couple of hard facts we can easily say about returning a borrow.

```rust
fn better_luck_next_time() -> &bool {
    let x = true;
    &x
}
```

This is rightly forbidden.  `&x` locks `x` for reading, and is then copied into the return register where it continues to hold the lock.  When `x` is later deinitialized at the closing brace, a conflicting write-lock is produced.

```rust
fn oh_hey_that_works() -> &bool { &true }
```

This one is interesting! Rust has a feature where `const` expressions are promoted into `static` items when borrowed. But as stated previously, `static`s are not lockables!

In short: **The expression `&true` holds no locks,** and this example is rightly allowed.

```rust
fn give_it_back(x: &bool) -> &bool { x }
fn what_is_that(_: &bool) -> &bool { &true }
```

These functions are obviously safe, and they are also permitted by our borrow checker. Though we haven't touched on this yet, it's safe to say that an input argument cannot possibly have locks on any lockables defined in our function.[^reentrancy]

[^reentrancy]: Even reentrancy is not a problem; if our function called itself, there would be distinct copies of it on the callstack, with distinct lockables. And if you're worried about closures, I refer you back to footnote [^upvar].


What's interesting is that in one case, the function returns a borrow with no locks, whereas in the other, the output has locks from the input.  Both have the same signature... I wonder what implications this signature has for the caller?


## To be continued

So far we've done pretty well just by considering locks to be held intrinsically by the values that exist at runtime in a function body.  The simple borrow checker proposed here appears to be capable of verifying a broad range of function bodies, and surprisingly, it does not care one iota about the type system!

To rephrase, it seems that *all of the situations considered above can be accurately treated without any concept of "lifetimes."*

...but this is about to change.  In getting this far, we've had to rely on language-level magic like operators and value literals.  So in the next post, we're going to do something revolutionary and, frankly, quite frightening:

**We're going to call a function.**[^box-new]

[^box-new]: `Box::new` was magic and didn't count, okay?  We've been over this!

**Update:** [Part 3 is out!][Part 3]

## Comments and corrections

Please keep 'em coming on [this URLO thread](https://users.rust-lang.org/t/blog-post-lockout-everything-you-know-about-lifetimes-is-wrong/20483)!

---

## Notefoots

{% include series/lockout-links.md %}
