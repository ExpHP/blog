---
layout: post
title:  "Lockout, Part 4: Invariance without variance"
date:   2018-10-06 18:30:00 -0400
categories: rust series
# used for ToC generation
series: lockout
series-part-id: 4
---

This is part of a blog series on working towards an intuitive mental model for lifetimes in Rust.

{% include series/lockout-toc.html %}

---

[Part 2](blah) introduced a simple borrow checker without lifetimes, and [Part 3][Part 3] brought to our attention two serious shortcomings.  We managed to fix one of them, but another still remains!

## Fixing the "invariance example"

Let's focus again on the invariance example:

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

I call it the "invariance example" because, traditionally, rust uses the concept of invariance to prevent this from compiling.  Unfortunately for us, we cannot do the same, as the very notion of "variance" (a type system concept) doesn't even exist in our world without lifetimes!

If we're going to fix this, we'll need to handle it in our own way.

At (4), a temporary is created that holds a read-lock on `*boxy`, but it is quickly lost to the infinite void as the temporary is deinitialized at the end of the statement.  After that, there's nothing to stop us from overwriting `boxy` at (5).  In order to ensure that borrow checking fails, something must occur to somehow cause `outer_ref`---the only other thing in scope---to hold that read-lock!

But how?  Well, when we write to `*evil`, we know that it has a write-lock on `outer_ref`; perhaps we can use this somehow?

One could also devise trickier situations:

```rust
// replacing the block from `bad_extension` with:
{
    let (a, mut b) = (1, 2);
    let evil = (&a, Box::new((&mut b, 2, &mut outer_ref)));
    *(evil.1).2 = &*boxy;
}
```

In this case, even though our borrow checker isn't necessarily smart enough to realize that `(evil.1).2` points to `outer_ref`, it does know that `evil` holds a write lock on `outer_ref`, so similar logic can be applied.

```rust
// replacing the block from `bad_extension` with:
{
    let conspirator = &mut outer_ref;
    let evil = &mut *conspirator;
    *evil = &*boxy;
}
```

Here, `evil` holds a write lock on `*conspirator`... oh, and it also holds a copy of the write-lock on `outer_ref` thanks to those rules we recently added to fix reborrowing!  _Whew!_  Okay, so we can still apply that same logic.

With all of this in consideration, we can propose some kind of fix:

> After an assignment is made to an lvalue rooted in the local `local`, copies of all locks held by the argument should now be held by each lockable that is write-locked by `local`.

There may still be kinks to work out (and we may ultimately find that this strategy is entirely unworkable!), but with this adjustment, all three examples should now consider `outer_ref` to hold a read-lock on `*boxy`, which will conflict with the assignment to `boxy` at (5).

### Adjusting our constitution

You should hopefully have noticed something very fishy about the rule we just added.  This new rule appears to assume that all lockables are capable of holding locks themselves...  But according to [our constitution]({% post_url 2018-09-30-lockout-part-3 %}#our-constitution), locks are held by *values*---a concept completely orthogonal to lockables!

Basically, as written, *our constitution forbids us from talking about the locks held by a lockable.*  We must amend it to make this discussion possible.

So... here's where things get interesting!  You see, in earlier drafts of part 3, I originally tried tackling this example before the reborrowing examples.  At the time, each lockable did in fact correspond directly to a value (since they were all just locals), so I amended the constitution simply by saying that "lockables are a subset of a function's values."

This certainly seemed like a safe bet at the time, but it is no longer a possibility; the deref lockables that were added in Part 2 are *not* values, and they can't hold locks!  In fact, this raises a heck of a lot of questions.  For instance:

* can an example be constructed showing that we somehow *need* to add locks to a deref lockable?
* what kind of role does deinitialization play here?  Would `*borrow` for a `&T` or `&mut T` local ever release its locks, considering that it is not deinitialized?
* Maybe it *is* deinitialized, but this does not test it for writing?

There's too many wildly different directions we can go. It's kind of making my head spin!

### Keep it simple, stupid!

Personally, I don't want to have to throw all of our existing ideas about values and deinitialization out the window.  There is too much at stake there, too many hard questions, and frankly, no guarantee that we could ever recover from it.

Therefore, to maximize flexibility at minimum cost, I suggest that we add a new concept which is completely orthogonal to all of the others:

> **Amendment (links):** A lockable may be **linked** to one or more values; basically, the borrow checker carries a `links: HashMap<Lockable, HashSet<Value>>` field.

That's it; we merely added a data structure, with no mention of how it is to be used (after all, it may prove useful for purposes not yet anticipated!).  That shall be the implementation's job.

### The new implementation

So first, let's get this out of the way; the whole entire reason we're even talking about links is that we needed a way to connect the _lockable_ for `outer_ref` to the _value_ for `outer_ref`.  So let's add the one case we obviously need:

> The lockable for a local named `local` is linked to the value stored in `local`.

Now, for all we know at this point, these may be the only links we'll ever need, in which case the whole idea may have been a bit overengineered.[^kiss]  This doesn't really concern me; I deliberately erred on the side of flexibility in order to enable us to ask questions that we couldn't ask otherwise.

[^kiss]: So much for keeping it simple, stupid.

Next, let's state what we intend to use links for.  This rule shall replace the nonsensical one that was put forth a couple of `<h3>`s ago:

> Consider an expression which uses `=` to assign a temporary `temp` to an lvalue rooted in the local `dest`.  Then:
> * For each lockable that is locked for writing by `dest`:
>   * For each value linked to that lockable:
>     * That value now holds copies of all locks held by `temp`.

It certainly is a mouthful (such a mouthful that I had to resort to a triply-nested singleton list!); but it finally provides a way for us to modify locks in response to assignment.

And with that, `bad_extension` is finally fixed!  (Feel free to verify for yourself!)

Everything is wonderful now! No more problems, not ever, no more!  Welp, I'm off!

<!-- 
```rust
fn bad_extension() {
    let mut boxy = Box::new(0);
    let mut outer_ref: &i32 = &0;
    {
        let evil: &mut &i32 = &mut outer_ref;  // (1)
        *evil = &*boxy; // (2)
    } // (3)
    boxy = Box::new(0); // (4)

    assert_eq!(outer_ref, &0); // UB!
}
```

* At (1) `evil` holds a write-lock on `outer_ref`.
* At (2):
    * The RHS `&*boxy` holds a read-lock on `*boxy`.
    * The LHS `*evil` is rooted in `evil`, which holds a write-lock on the lockable `outer_ref`, which is linked to the local `outer_ref`.
    * Hence, after the assignment, `outer_ref` now holds a read-lock on `*boxy`.
* At (3), `evil` is deinitialized, releasing the write-lock on `outer_ref`.
* At (4), `boxy` and `*boxy` are tested for writing.  **This conflicts with the read-lock of `*boxy` held by `outer_ref`!**
-->

_\*Rides off on a unicorn into the sunset\*_

<div class="figure medium"><img alt="Sunset dot jay-peg" src="/assets/img/post/lockout/sunset.jpg"/></div>

...

...yeah... I'm pretty sure you can guess where this is going.  Because if there's one thing any of us know for absolute certain:

## There are no sunsets here

### A counterexample for deref lockables

I mentioned this before but... *do* deref lockables need to be linked to something?

It's an interesting question; to answer it in the affirmative, all we need to do is find a counterexample that exhibits unsoundness. Answering it in the negatory is... not so easy.  So honestly, I rather hope that the answer is yes!

In order to find a counterexample, we probably need to start from something similar to `bad_extension`, except that `evil` needs to hold only a lock on deref lockables. So the first question is: Is that possible?

And it is:

```rust
fn only_holds_deref(mut boxy: Box<i32>) {
    let evil = &mut *boxy; // holds a lock on *boxy
}
```

Okay.  Next, we need to use this to secretly store a lock somewhere that formerly had none.

```rust
fn shenanigans_via_deref() {
    let mut boxy = Box::new(&3);
    let evil: &mut &i32 = &mut *boxy;

    let int = 3;
    *evil = &int;
}
```

Yep. Yep. This looks promising!  I like it when things look promising!  Let's land the finishing blow!


```rust
fn ub_via_deref() {
    let mut boxy = Box::new(&3);
    {
        let int = 0;
        let evil: &mut &i32 = &mut *boxy; // only locks *boxy
        *evil = &int; // fails to save a read-lock on int
    } // evil is deinitialized, followed by int
    assert_eq!(*boxy, &0); // UB!
}
```

So it would appear that the following rule should be added:

> Any value linked to `lockable` is also linked to `*lockable` (if it exists).

This links the lockable `*boxy` to the value of `boxy`, so that after the assignment, `boxy` holds a lock.

### Dumb question... You handled `*x = value;`, but what about `x = value;`?

Don't be silly, there's no such thing as a dumb question! But as you can see, it is clearly already handled:

```rust
fn ub_via_plain_assignment() {
    let mut boxy = Box::new(&3);
    {
        let int = 0;
        boxy = Box::new(&int); // (1)
    } // (2)
    assert_eq!(*boxy, &0); // UB!
}
```

* At (1), the lvalue `boxy` is rooted in the local `boxy`.
    * `boxy` holds no write-locks, so there are no links to follow.
    * `boxy = &int;` therefore does not copy the lock on `int` to anywhere, so it is released.
* _...ohhhhhhhhh._

I, uh... guess it isn't handled.  Come to think of it, neither is this:

```rust
fn ub_via_deref_assignment() {
    let mut boxy = Box::new(&3);
    {
        let int = 0;
        *boxy = &int; // <-- only line that changed
    }
    assert_eq!(*boxy, &0);
}
```

Wow.  I've put so much energy into making sure we can't secretly modify something *indirectly* that our solution completely fails to notice when something is modified *directly!*  ...but alright, alright.  This is no problem.  Let's say that before each function is borrow-checked, it undergoes a one-time source transformation:

```rust
// any expression of the form
$lvalue = $expr

// becomes
{
    let temp = $expr;
    let mut_ref = &mut $lvalue;
    *mut_ref = temp
}
```

We can be certain this works because anything write-locked by `$lvalue` will also be write-locked by `mut_ref`, and---

wait a second.  Is that true?  I don't think that's true!! If you think back to the [rules I laid out for deref lockables]({% post_url 2018-09-30-lockout-part-3 %}#deref-lock-rules) near the end of Part 3, `&mut local` doesn't copy locks, only `&mut *local` does! Why did I do something so silly!?

Hmm, let's see, let's see, what was my reasoning... lemme just...

...ah, that's right! It was:

> Honestly, I just put a bunch of examples into the playground in an attempt to reverse engineer rustc's region-based borrow-checker using this mental model.

Right.  In other words, it was _lost to the sands of time._

<div class="figure medium">
    <img alt="A block of swiss cheese" src="/assets/img/post/lockout/swiss-cheese.jpg" />
    <div class="caption">My borrow checker. (artist's impression)</div>
    <div class="credit">Ekg917, CCSA 4.0 via wikimedia commons</div>
</div>

### Time out, time out, time out!!!!

Alright.  I think it's about time we start managing our expectations here. There's a couple of facts that I think we can probably all agree on.

1. A number of issues we've encountered have required wide-reaching changes.  **Without regression tests, we have no hope of continuing to fix such issues without breaking stuff that used to work.**
2. The rules are getting complicated and they may get worse over time. **Without an implementation, we have no hope of checking regression tests.**
3. I'm sure that if we kept going on certain tangents to fix more bugs, new patterns may eventually become apparent that would allow us to simplify our implementation; but the problem is, we have to get there. There's too many moving parts; too many things to think about. **We can not cover it all in the space of a couple of blog posts.**

Unfortunately, I really don't know how to implement a static analysis tool like this!  I guess some kind of, what do they call it... data flow analysis?  That a thing?

For these reasons, this blog series doesn't really have any hope of providing a conclusive answer to the question of whether rust-without-function-calls can be fully borrow checked without lifetimes. Really, the best I can hope to do is to help paint broad strokes, and hope that one day some brave warrior may do what I could not and fill in the details.

So I'm going to leave aside some of those bugs that were just mentioned, and focus on more of the big-picture details. Like this one:

### Machine integers holding locks!

So, think back to our rule.  Basically, *all write locks* held by a `&mut` borrow are used to propogate copies of locks from the input. Don't you think this sounds pretty... conservative?

Because it certainly is!

```rust
fn now_this_is_just_silly() {
    let mut just_an_integer = 1;
    {
        let inner = 0;
        
        let evil = (&mut just_an_integer, &mut &0); // (1)
        *evil.1 = &inner; // (2)
    } // (3)
    assert_eq!(just_an_integer, 1);
}
```

Our borrow checker denies this!

* at (1), `evil` holds a write lock on an integer.
* after (2), **that integer holds a read-lock on `inner` thanks to our new rule.**
* at (3), borrow checking fails when `inner` is deinitialized.

I shouldn't have to say it, but... **this is absurd!!**  `just_an_integer` is... well, *it's just an integer!*  There's no way on earth that the deinitialization of some other variable somewhere else invalidates it! *It shouldn't hold any locks!!*

#### In fact, we already had this problem!

Something I noticed when I went ahead to start working on part 5...

I've never written a field projection, have I?

```rust
fn wow_much_silliness() -> i32 {
    let int = 1;
    let tuple = (1, &int);

    let another_int: i32 = tuple.0;
    another_int
} // error: value deinitialized while locked for reading.
  //        ...wait, WHAT!?
```

This has never been explicitly spelled out, but: our borrow-checker must conservatively assume that the value expression `tuple.0` holds all of the locks held by `tuple`.  So `another_int` holds a read-lock on the local `int`, and this read-lock is copied alongside the value wherever it goes, leading to the error above!

#### Declaring types that hold no locks

We know that, at a very fundamental level `&expr` and `&mut expr` are the only expressions that create locks. Furthermore, we know from experience with the _true_ Rust that there is a pattern behind which types can hold locks.

Maybe we could have an annotation for lockless types... or how about an auto-trait?

```rust
// taken to be true by the language
// unsafe impl LockLess for i32 { }

struct Int(i32); // automatically impls LockLess
struct Int(&i32); // does not impl LockLess
```

...unfortunately, this doesn't really seem to be worth our time because it merely pushes the goal posts.  If we have a `(&i32, &i32, &i32)`, then taking the first field of that will still hold locks that originated from the other two fields.

#### Making fields lockable

I mentioned in the previous episode that rust considers both deref projections and field projections to be places.  We made deref projections lockable... what if we did the same for fields?

Hah... it might work, but I don't want to touch that can of worms with a ten foot pole.

<div class="figure x-small">
    <img alt="A white flag" src="/assets/img/post/lockout/white-flag.png" />
    <div class="credit">KissPNG<br/> labeled for noncommercial reuse</div>
</div>

## To be continued

These last two episodes have gone on quite a tangent!  Fixing our borrow checker has certainly been a... humbling experience, and I'm afraid I gotta raise the white flag on this one.

Remember, the whole goal of writing a borrow checker without lifetimes was to provide a baseline experience for comparison when lifetimes are finally introduced.  We can see that while solutions appear to exist, they can get pretty complicated; at least, too complicated to work out in one's head.  Hopefully, things will get easier once we start to introduce lifetimes.

...till next time!

**Update:** [Part 5][Part 5] is out! And it's a biggie!

## Comments and corrections

You can keep 'em coming on [this URLO thread](https://users.rust-lang.org/t/blog-post-lockout-everything-you-know-about-lifetimes-is-wrong/20483)!

(though I've never liked using Discourse for any thread that exceeds 20 posts... anyways, it's what we've got)

<!-- FIXME should instead do this by sticking something into the `footnotes` div directly, through... hell, I dunno. JS? CSS? -->
---

## The Foot Note

{% include series/lockout-links.md %}
