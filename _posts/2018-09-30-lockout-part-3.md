---
layout: post
title:  "Lockout, Part 3: Really reborrowing"
date:   2018-09-30 14:30:00 -0400
categories: rust series
# used for ToC generation
series: lockout
series-part-id: 3
---

This is part of a blog series on working towards an intuitive mental model for lifetimes in Rust.

{% include series/lockout-toc.html %}

---

Let's start with a recap of our exploration into the borrow checker.

*Wait, what?!,* I hear you say! *A recap already? It has only been one post!*

Well, yes... but I want to throw a new perspective on what we just did.  Trust me!

## A recap

### Two levels of rules

[Part 2][Part 2] introduced a whole bunch of rules, but from now onwards I'd really like to differentiate them into two groups based on their level of impact: They are our **constitution,** and its **implementation.**

### Our constitution

These are the extremely high-level rules that decide what form the rest of the rules are allowed to take.  They decide what kind of data we're allowed to care about (values? types?), and what kind of reasoning we're allowed to perform.

**These are the rules that we're really interested in exploring!**  Each new concept or mode of analysis we add may enable us to borrow check a greater subset of Rust. As will eventually be shown, embedding information into types solves a great deal of problems, but it is fascinating to discover the boundaries of what can be solved without it!

When we last left off, our constitution looked something like this:

* Our borrow checker is allowed to look at a single function body, and the signatures of functions it calls.
* The body of a function implicitly defines a finite set of **lockables**.
* Certain expressions in the body, when evaluated, may **lock** these lockables for reading or writing.
  * Sometimes these are immediately released (just a test).
  * Sometimes they are held by the **values** that are percieved to exist at runtime, until their **deinitialization.**
* The borrow checker traces the creation and release of these locks throughout each control flow path.
* Borrow checking shall fail if---and only if---there exists a control flow path where a single lockable is simultaneously locked both for writing and for something else.

Notably, our constitution does not even *care* about types.  For this reason, I say that **this borrow checker has no concept of lifetimes.**

### The implementation

The bolded terms in our constitution above are our vocabulary, and the goal of the implementation is to define them.  These rules are far more malleable, and we will frequently modify them in an attempt to discover whether our constitution can even *work.*

When we last left off, our constitution seemed to be working pretty well!  Almost all of our problems could be solved through small adjustments to the implementation.  By the end, it looked like this:

* **Lockables** are:
    * Mostly just local variables. (much coarser than rustc, for simplicity!)
    * I also alluded to the concept of "upvars" in a footnote; a closure's captured locals are distinct lockables from the locals they capture.
    * `const`s, `static`s, and `fn`s are **not** lockables.
* **Values** are either:
    * The temporary value produced by an expression.
    * A value stored in a local.
* **Deinitialization** happens when a value's scope is exited, or it is moved.
    * Returning a value simply copies or moves it into a "return register," where it won't be deinitialized.
    * Something analogous happens for the trailing expression in a block.
* **Locks** are created as follows:
    * moving or copying a value duplicates its locks; consider them refcounted.
    * `&lockable` creates a brand new read-lock on `lockable`, and holds it.
    * `&mut lockable` creates a brand new write-lock on `lockable`, and holds it.
    * a literal tuple or struct holds the union of all locks held by the input fields.
    * when branching paths of control flow merge, a value holds the union of all locks that it would have held after each individual path.
    * reassignment tests for writing.
    * deinitialization tests for writing.
    * copying tests for reading.
    * moving tests for writing, because it deinitializes.

## Some unexpected difficulties

In Part 2, I deliberately avoided all forms of function calls.  I even declared `Box::new(x)` to be *language-level magic syntax* for a "Box literal," so that it could be given special borrow semantics (basically the same as a struct literal).

The reason I avoided function calls was because I knew they would very readily threaten our simple constitution---perhaps even finally forcing us to add some analogue to lifetimes.  And I promised I would get to them in part three.

...little did I know at the time that I was lying!

It turns out there's a couple more things I need to point out.  They're bad.  They're things that I only noticed after posting Part 2.  Our borrow checker can't handle them.  *One of them is a soundness hole!*  And they are very nontrivial to fix.

### Reborrowing is not so expertly-handled after all!

Let's review how our borrow checker handles reborrowing.

```rust
fn reborrow_review() -> &mut i32 {
    let mut int = 3;
    let borrow = &mut int;
    let reborrow = &mut *borrow; // should be allowed
    &mut *reborrow // should be forbidden
}
```

Our borrow checker is able to handle this function with an extremely shallow analysis:

* `reborrow` is correctly allowed to coexist with `borrow`, because they hold locks on different lockables.
* The `&mut *reborrow` return value is correctly forbidden, on the basis that it holds a lock on `borrow` (a local which gets deinitialized).

But there's an issue with our reasoning in the second bullet.  It also means that we incorrectly reject the following:

```rust
fn remote_reborrow(borrow: &mut i32) -> &mut i32 {
    // this should be okay, but it is rejected!
    // (`borrow` is deinitialized while locked!)
    &mut *borrow
}
```

Our shallow analysis is not good enough to differentiate between these two cases!  It seems evident, then, that `&mut *borrow` should *not* hold a lock on `borrow`.  But what should it lock instead?

...don't answer that yet! There's still more badness:

### The invariance example

@matklad [commented](https://users.rust-lang.org/t/blog-series-lockout-everything-you-know-about-lifetimes-is-wrong-part-2/20483/10?u=exphp) in response to part 1:

> I also very much feel that I don’t actually really understand lifetimes. And I agree that the main bit I don’t understand is “what is the purpose of lifetimes”. More formally, I “understand” how lifetime inference works: given a source of a function, you write down a set of constraints and then find a minimal solution.
>
> What I don’t understand is why this is sound, what are the progress and preservation properties.

Now, I can't say much about the concept of soundness,[^type-safety] and my response was more or less that I don't even think of them as constraints anymore!

But while it's easy for me to *say* this, I figured it would be much more compelling if I could actually *show* that our borrow checker without lifetimes can handle the same issues normally handled by special subtyping rules in rustc.  What follows is the archetypal example for why `&mut T` is invariant in `T`:

[^type-safety]: This was honestly the first time I've ever even heard of the terms "progress" and "preservation!"  I'm glad to have these terms I can go look up now, and I'm excited to learn about them; but until then I can't say much about it. =P

```rust
fn bad_extension() {
    let mut boxy = Box::new(0); // (1)
    let mut outer_ref: &i32 = &0; // (2)
    {
        // secretly hide a read-lock inside outer_ref by indirection
        let evil: &mut &i32 = &mut outer_ref; // (3)
        *evil = &*boxy; // (4)
    }
    // invalidate the read-lock
    boxy = Box::new(0); // (5)

    assert_eq!(outer_ref, &0); // UB!
}
```

Naturally, borrow checking should fail:

* At (2), `outer_ref` is created, holding no locks.
* At (3), `evil` is created, locking `outer_ref` for writing.
* At (4), the temporary value for `&*boxy` holds a read-lock on `boxy`.  <br />
  The temporary is copied into `*evil`, i.e. `outer_ref`, then disappears.
* At (5), `boxy` is briefly locked for writing.  **This is our one chance to throw an error!...**

But...

...but... the read-lock on `boxy` is released at the end of line (4), when the temporary value is deinitialized. To fix this, our borrow checker must somehow be able to determine that a copy of this read-lock should be held by `outer_ref`.

## Can we save these examples?

To be entirely honest, up until now, I thought that opaque function calls were the *exclusive* motivation for lifetimes; i.e. that all of rust can be accurately borrow-checked without lifetimes, so long as we do not call functions.

And I'm tempted to believe that is still the case. So here comes the challenge:

* **Can these problems be fixed without needing to amend our constitution?**
* **Can these problems be fixed _in any manner_ without embedding information into types?**

Let's take these examples one at a time, starting with reborrowing.

## Fixing reborrowing

Repeated for your convenience:

```rust
fn remote_reborrow(borrow: &mut i32) -> &mut i32 {
    &mut *borrow // this should be OK
}

fn reborrow_review() -> &mut i32 {
    let mut int = 3;
    let borrow = &mut int;
    let reborrow = &mut *borrow; // this should be OK
    &mut *reborrow // this should be forbidden!
}
```

* `remote_reborrow` shows us that `&mut *borrow` must not hold a lock on `borrow`.
* `reborrow_review` shows us that `&mut *borrow` here must hold a lock on *something*,,, probably `int`.

This is easy to fix, no?  We can just claim the following:

* the value `&mut *borrow` doesn't hold a lock on `borrow`
* instead, it only holds (refcounted) copies of the locks held by `borrow`. (in this case, of `int`)

Now `&mut *borrow` is allowed to outlive `borrow` because no lock is held on it; `reborrow` and `borrow` are still allowed to coexist, because between them there is only a single, refcounted write-lock on `int`; and the return value of `reborrow_review` is still forbidden because `&mut *reborrow` holds a write-lock on the local `int`! Easy peasy, right?

...but come on. I know it, you know it, the neighbor's dog knows it; _nothing is ever that easy._  Now that reborrows don't lock their originating borrows... wouldn't you suppose that this might cause some problems?

Spoiler alert: *You should.*

```rust
fn my_bad() {
    let mut boxy = Box::new(3);
    let borrow = &mut boxy;
    let reborrow_1 = &mut *borrow;
    let reborrow_2 = &mut *borrow; // (1)

    let int_ref = &mut **reborrow_1; // (2)

    *reborrow_2 = Box::new(0); // (3)

    assert_eq!(int_ref, &mut 0); // UB !
}
```

This example looks a bit noisy,[^lot-going-on] but the basic point is that our updated rule *allows* multiple aliasing `&mut` borrows:

[^lot-going-on]: ...sorry about that! In all fairness, I probably could have cut this example after `(1)`, but I've been making it a point to ensure that all unsoundness examples end in Undefined Behavior; this way, nobody gets distracted by examples that are "fixed by NLL."

* At (1), well... this is allowed now! `borrow`, `reborrow_1`, and `reborrow_2` all simply hold the same ref-counted write-lock on `boxy`.
* At (2), we haven't really specified what locks are held by `&mut **reborrow_1` (and thereby `int_ref`), but per our current constitution, the only locks that it conceivably *could* hold are __(a)__ a new lock on `reborrow_1`, and __(b)__ the refcounted lock of `boxy` held by `reborrow_1`. For the sake of argument, we will suppose it holds **both of these locks** for now.
* At (3), `boxy` is indirectly overwritten through `reborrow_2`.  <br />
  Currently, this only tests `reborrow_2` for writing, so it is allowed.

How can we make the usage of `reborrow_1` and `reborrow_2` conflict?  Thing is, they both only hold a lock on `boxy`!  One might naively say that the assigment at (3) should test `boxy` for writing, to conflict with the lock held by `reborrow_1`... but that would also conflict with the lock held by `reborrow_2`! (doing this would in fact forbid *all* statements of the form `*ptr = value`!)

### Inspiration from rustc

I'd like to keep our analysis as local as possible.  So I'll focus on this:

```rust
let borrow = &mut boxy;
let reborrow_1 = &mut *borrow;
let reborrow_2 = &mut *borrow; // <---- make this fail!
```

If we can produce a borrow error on the third line like we used to, it would solve all of our soundness issues.  But we've already determined that:

* having reborrows lock the originating borrow (`borrow`) is too conservative, breaking examples like `remote_reborrow`.
* having them independently lock the borrowed value (`boxy`) is even worse; all `&mut` reborrowing would be impossible!
* having them simply share a lock on `boxy` is unsound.

Here is where I'm going to draw a little bit of inspiration from rustc:

Our lockables and locks vaguely correspond to rustc's own concepts of *places* and *loans.*  In fact, early drafts of this blog series even used the term "place" instead of lockable; but places are not so much a borrowck concept as they are a MIR concept (they're "MIR variables"), and their design probably incorporates many other concerns such as lowering to LLVM IR.

In addition to locals and closure upvars, the MIR considers the following things to be places:

* Field projections: `place.field`
* Deref projections: `*place`

Now, I don't know much as to the reason *why* it considers these to be places; maybe it has something to do with borrow-checking, or maybe not. Nonetheless, it *does* give me an idea.

### Introducing deref lockables

Without touching our constitution, we can introduce a new type of lockable as an implementation detail.

* **Deref lockables:**  For any lockable `lockable` that can be dereferenced, we will additionally define `*lockable` as a lockable.

To clarify, consider the following snippet:

```rust
let mut int = 3;        // lockables:  int
let borrow = &mut int;  // lockables:  borrow, *borrow
```

For our purposes, __`int` and `*borrow` are considered to be distinct lockables,__ and they can be locked independently of one another.  And in fact, reborrows will need to hold *both* of them!

This requires a drastic revision of our rules about when locks are created.  I'll try my best to write what I think the new rules should be.  Please don't feel guilty if your eyes begin to glaze over reading it; this won't be on the test!

<span class="anchor" id="deref-lock-rules"></span>Locks are now created as follows.  Whenever you see "`lockable` (and `*lockable`...)," it includes `**lockable` and so on.

* moving or copying a value duplicates its locks; consider them refcounted.
* a copy from `local` (or `*local`...) tests `local` (and `*local`...) for reading.
    * To clarify my compressed notation: <br/>
      A copy from `local` tests `local` (and `*local`...) for reading. <br/>
      A copy from `*local` tests `local` (and `*local`...) for reading. <br/>
      A copy from `**local` tests `local` (and `*local`...) for reading. <br/>
      ...
* a move from `local` (or `*local`...[^box-move]) tests `local` (and `*local`...) for writing.
* `&local` tests `local` (and `*local`...) for reading, and holds a brand new read-lock on `local`.
* `&*local` (or `&**local`...) tests `local` (and `*local`...) for reading, holds a brand new read-lock on `*local` (or `**local`...), **and duplicates all locks held by `local`**.
* If you do `&mut` instead of `&`, then `s/read/write/g`.
* a literal tuple or struct holds the union of all locks held by the input fields.
* when branching paths of control flow merge, a value holds the union of all locks that it would have held after each individual path.
* `local = x;` (or `*local = x;`...) tests `local` (and `*local`...) for writing.
* deinitialization tests `local` __(but not `*local`!)__ for writing.

[^box-move]: Yes, there are [cases where `*local` can be moved](https://manishearth.github.io/blog/2017/01/10/rust-tidbits-box-is-special/).

The entire point of deref lockables really boils down to a few simple words, emphasized in the last bullet: *They are not deinitialized.*  Aside from that, if you look closely, you should see that `*lockable` is otherwise equivalent to `lockable` for almost all intents and purposes, and that attempts to lock one of them will almost always conflict with locks on the other.

I also kept in the rule about duplicating locks, to make sure the returned borrow of a temporary in `reborrow_review` doesn't slip through unnoticed.

You may be wondering: Why these precise rules?  Honestly, I just put a bunch of examples into the playground in an attempt to reverse engineer rustc's region-based borrow-checker using this mental model.  All I can tell you is that, *gee golly, I hope it works!*

...but without an actual implementation of my borrow-checker to play around with and a large repository of examples, it is difficult to tell.

### Just one example

I'm not going to review the reborrowing examples to show how the new rules fixed them; though I am at least pretty sure that they are fixed.[^prove-me-wrong]  Sadly, the new rules are a fair bit more taxing to apply, mentally speaking; more things hold more locks than they used to, thanks to the new rule about lock duplication through `&*local`.  This makes it harder to track where they all go, and to recognize when one of them escapes a block.

[^prove-me-wrong]: Proving me wrong is left as an exercise for the reader.  _Get to it!_

I'll take a walk through just one example using the new rules, because I gotta know: *might we have fixed this already?*

```rust
// here I am again!!
fn bad_extension() {
    let mut boxy = Box::new(0); // (1)
    let mut outer_ref: &i32 = &0; // (2)
    {
        // secretly hide a read-lock inside outer_ref by indirection
        let evil: &mut &i32 = &mut outer_ref; // (3)
        *evil = &*boxy; // (4)
    }
    // invalidate the read-lock
    boxy = Box::new(0); // (5)

    assert_eq!(outer_ref, &0); // UB!
}
```

* (1) and (2) create no locks.
* At (3), `evil` receives a new write-lock on `outer_ref`.
* At (4), the expression `&*boxy` tests both `boxy` and `*boxy` for reading, and the resulting temporary value holds a read-lock on `*boxy` as well as copies of all locks held by `boxy` (of which there are none). Then `evil` and `*evil` is tested for writing, and the temporary disappears, releasing the lock on `*boxy`.
* At the closing brace, `evil` falls out of scope, releasing the lock on `outer_ref`.
* At (5), `boxy` and `*boxy` are tested for writing, but neither are locked.
* Borrow checking succeeds.

Well, crud.  Looks like we still gotta fix this.

And also... wait a second... <br />
did I just say that `&*boxy` doesn't lock `boxy`?  Doesn't that mean... ahh, crap.

### One final surprise: `&T` and `&mut T` must be special!

```rust
fn bad_box_reborrow() -> &i32 {
    let boxy = Box::new(0);
    &*boxy // holds a read-lock on *boxy
} // `*boxy` does not get write-tested; borrow-checking succeeds!!
```

Sigh... yep.  I noticed this only at the eleventh hour, during my final proofreading check.  It seems that last bullet in our revised implementation ought to instead be

* deinitialization tests `local` for writing.
    * it also tests `*local` (and `**local`...), **unless `local: &T` or `&mut T`.**

At first glance, this would seem to be nothing more than an obviously flawed bandaid that introduces unnecessary special cases; you'd start to see the man behind the curtain as soon as you had a trivial wrapper struct around a `&T`!

Well, here's what's funny:  Forget about our borrow checker for a moment and think back to the normal Rust language.

```rust
// Back in the *real* rust language...

struct Ref<'a, T: 'a>(&'a T);

impl<'a, T> Deref for Ref<'a, T> {
    type Target = T;

    fn deref(&self) -> &T { self.0 }
}

fn reborrow_borrow<T>(x: &T) -> &T {
    &*x
}

fn reborrow_newtype<T>(x: Ref<'_, T>) -> &T {
    &*x
}
```

Think about the signature of `Deref::deref`, and ask yourself: What mechanism in Rust allows `reborrow_newtype` to pass borrow-checking?

...that was a trick question. [rustc forbids `reborrow_newtype`!](https://play.rust-lang.org/?gist=27e30da203f71e274d5e0f3243f7ae8b&version=stable&mode=debug&edition=2015)  __This aspect of reborrowing is language-level magic that only works for `&T` and `&mut T`, even in rustc's own borrow checker!!__

## That's it for now

I think that's a nice note to leave off on, and besides, this post has already surpassed critical mass. The invariance example is going to have to wait until next time.  I can assure you I've already spilt much ink over it,[^lcd] and I will probably need to spill that much more, because the deref lockables I just introduced have almost entirely thwarted my efforts to fix it thus far.

You might find that surprising.  I would too, if I haven't already been there!  The thing is, no matter how it's done, the implications of the invariance fix are sure to be wide-reaching.

In short: It *cannot* be fixed without amending our constitution.

**Update:** [Part 4 is out!][Part 4]

[^lcd]: I think LCD screens have some kind of ink in them, right?  I'm gonna say yes. Definitely yes. I've decided, and there's nothing you can do about it.


## Comments and corrections

Please keep 'em coming on [this URLO thread](https://users.rust-lang.org/t/blog-post-lockout-everything-you-know-about-lifetimes-is-wrong/20483)!

If you happen to be a visitor from the distant future who doesn't want to necro a dead forum thread, then I imagine I may have succeeded at setting up comments by then.  In that case... scroll down I guess? _\*shrug\*_ That's probably where I'd put them.

---

## Sbbgabgrf[^sbbgabgrf]

[^sbbgabgrf]: Bzrqrgbh tbmnvznfh!... anuuuuu, nalobql pbhyq unir svtherq gung bhg. Lbh'er abg fcrpvny.

{% include series/lockout-links.md %}
