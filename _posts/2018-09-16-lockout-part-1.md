---
layout: post
title:  "Lockout, Part 1: Everything you know about lifetimes is wrong."
date:   2018-09-16 12:00:00 -0500
categories: rust series
# used for ToC generation
series: lockout
series-part-id: 1
---

Well, hello again!  This is going to be part of a blog series on a new way to look at lifetimes in Rust's type system. I hope to cover some advanced aspects of lifetimes that are seldom discussed in the open, and my goal is ultimately to help convey new intuitions about how to use them correctly.

{% include series/lockout-toc.html %}

---

> *Hey pop-pop?  When I write `struct Ref<'a, T>(&'a T)`, why do I need to require that `T: 'a`?*
>
> **Well, junior, that's to protect you from dangling pointers!  We gotta know that `T` lives at least as long as `'a` so that it outlives the reference!**
>
> Wow, pop-pop!  So I can make a `Ref<'a, String>` for any `'a` I want, then?  Even `'static`?
>
> **Ha ha, slow down there, junior! Unless you're using `lazy_static`, the borrow checker would stop you when your string gets dropped!**[^string-new]
>
> But `String: 'static`, so we know it outlives the reference!... right pop-pop?
>
> **...uh**

[^string-new]: Alright, yeah, *technically* once the `const`-ness of `String::new` is stabilized, you'll be able to make a `&'static String` that way as well. But junior is no doubt thinking of doing this *at runtime.*

## Lifetimes are *not* easy

Whenever people say that they *understood Rust's lifetimes quickly,* or that *they don't understand the fuss over them,* I regard this statement with extreme suspicion... because the way lifetimes are taught simply *does not add up* to a self-consistent whole in the long run, and as a result, any attempt to write lifetime-heavy code involves an unhealthy amount of cognitive dissonance.

### A personal story

Personally speaking, for years,[^years] I was afraid of lifetimes.  I mean, I understood *why they were there.*  And if I was given a signature with the right lifetime annotations, I could probably make sense of it.  But if I had to come up with the correct signature on my own?  There was simply no way.

And then one day not too long ago while prototyping something, I suddenly realized that I had just written the following without even stopping to think about lifetimes:[^atrocity]

[^years]: By which I mean ~1-2 years, i.e. *since basically Rust 1.0.*

```rust
// (... some methods and docs snipped ...)

pub trait PotentialBuilder<Meta = Element>: Send + Sync {
    /// "Clone" the trait object.
    fn box_clone<'a>(&self) -> Box<dyn PotentialBuilder<Meta> + 'a>
    where Self: 'a;
    
    fn initialize_diff_fn<'a>(
        &self,
        structure: Structure<Meta>,
    ) -> FailResult<Box<dyn DiffFn<Meta> + 'a>>
    where Self: 'a;

    /// dumb dumb dumb stupid implementation detail.
    ///
    /// A default implementation cannot be provided. Just return `self`.
    fn _as_ref_dyn<'a>(&self) -> &dyn (PotentialBuilder<Meta> + 'a)
    where Self: 'a;
}
```

[^atrocity]:  I later decided to remove lifetimes from this atrocity by sticking `Rc` all over the codebase.  Just because you *can* write the lifetimes doesn't mean you should...

Mind, this is a fairly unconventional use of lifetimes! It's a trait object parameterized over a lifetime, so that the implementations can have borrowed data... but it also uses `where Self: 'a` bounds rather than the more common form `trait PotentialBuilder<'a>`.  (There is a reason for this, but it is... *nuanced.*[^nuanced])

[^nuanced]: In short, [the alternative would have had problems with invariance](https://play.rust-lang.org/?gist=83450ca19fbe09e58344c5292188091c&version=stable&mode=debug&edition=2015) due to my decision to use trait objects.

Now, that's all fine and dandy, but... **_how?_** When did I learn to write things like this?  I honestly wasn't sure.  In fact, if you asked me, I'd say that *I still felt like I didn't understand what lifetimes really were.*

I honestly *could not tell you* what I thought `'a` represented in the above code.<br/>
I truly *could not explain to you* my reasoning behind where it appears.<br/>

It was merely the case that, after two years of writing Rust, I *somehow* knew the places where it belonged.  Was it habit?  Operant conditioning?!

What a sorry set of circumstances to have come so far yet still understand **nothing!**

### A light at the end of the tunnel

...some time has passed since then.  At some point, Nicholas Matsakis posted about a [new borrow checking scheme for rustc dubbed **Polonius**](http://smallcultfollowing.com/babysteps/blog/2018/04/27/an-alias-based-formulation-of-the-borrow-checker).  His post is highly technical and focuses largely on the implementation.  To be honest, I don't think it is very accessible to a non-CS major!

But the fundamental idea behind the new algorithm *makes sense.*  When I saw it, I finally could put into words my intuition about how lifetimes work.

My goal with this blog series is to try and help communicate this understanding, by writing from the perspective of **a user like you.** To get there, however, I must first shatter your current understanding of lifetimes.  Let's start with a review, shall we?

## Reminder: A summary of lifetime rules

In rust source code, `'a` represents a lifetime.  This is generally regarded to be the duration during which *some value* will continue to exist, measured from now until its deinitialization.

+ *Deinitialization* here does not refer to Drop impls, but rather to moves of non-`Copy` data, as well as the loss of the stack space associated with any value (POD or not) when its scope is exited.

### Where lifetimes appear

+ ...in the primitive types `&'a T`, `&'a mut T`,  and `dyn Trait + 'a`.
+ ...in the, uh, thing-that-is-kinda-sorta-but-not-really-a-type `impl Trait + 'a`. (both in argument position and output position)
+ ...in the type parameters or type arguments of a generic type, function, or trait.

### Bounds
Lifetimes can have relationships between them, expressed like trait bounds.
+ The bound `'b: 'a` is often read as *`'b` is at least as long as `'a`.*
+ The bound `A: 'a` is often read as *`A` lives at least as long as `'a`.*

### Elision

Lifetimes can often be left out of a function signature, to be filled in by defaults.  This process is known as **lifetime elision.**
  + The [three basic rules](https://doc.rust-lang.org/book/first-edition/lifetimes.html#lifetime-elision) are straightforward; **This blog series will assume you know them.**
  + There's some additional possibly tricky bits around `dyn Trait` and `impl Trait`; I'll always be explicit here.

### Subtyping

Rust has a subtyping mechanism that deals exclusively with lifetimes.
+ For the purposes of subtyping, lifetimes can be treated as types.
+ For lifetimes, when `'a: 'b` holds, **`'a` is a "subtype" of `'b`.** <br />
  (or if you'd rather think of it this way: **the longer lifetime is the subtype**)
+ A generic type `X<T>` is said to be:
    + **covariant** in `T` if `X<Subtype>` is a subtype of `X<Supertype>`
    + **contravariant** in `T` if `X<Supertype>` is a subtype of `X<Subtype>`
    + **invariant** in `T` if neither are true.

A summary of all variances: *(written with help from [the nomicon](https://doc.rust-lang.org/nomicon/subtyping.html))*
+ The vast majority of types are covariant in most or all of their type parameters.  We'll focus mainly on exceptions to this or noteworthy cases.
+ `&'a A` is covariant in both `'a` and `A`.
+ `&'a mut A` is covariant in `'a` and **invariant** in `A`.
+ `fn(B) -> R` is **contravariant** in `B` and covariant in `R`. <br />
    **No other primitive type is contravariant!**
+ `<S as Trait<'t, T>>::Assoc` is **invariant** in `S`, `'t`, and `T`.[^experimentation]
+ `dyn Trait<'t, T> + 'a` is covariant in `'a` and **invariant** in `'t` and `T`.[^experimentation]
+ `*const T` is covariant in `T`, while `*mut T` is **invariant**.
+ Types with interior mutability (`Cell<T>`, `Mutex<T>`, ...) are **invariant** in `T`.
+ `for<'a> fn(&'a T)` is... uhh... a trick question!

*There's something else I'm dying to say here, but that'll be in a future part.* =D

[^experimentation]: These are based on experimentation, as the the page on variance in the nomicon does not mention trait objects or associated types.

### Other notes

* `&'a T` and `&'a mut T` come with the bound that `T: 'a`.  People often interpret this as meaning "`T` must outlive borrows of `T`."  Currently, I'm... really not sure what the hell it *actually* means. (we'll get to that!)
    * It seems to me that **it plays no role in protecting you from dangling pointers.**
    * I *have* discovered legitimate use cases, but they're all in unsafe code. <br/>
      (...like I said; we'll get to that!)
* `'static` is a special lifetime that satisfies `'static: 'a` for all possible `'a`.  It is often described as the longest possible lifetime, or the "lifetime of your entire program." (alternatively, it is the subtype of all lifetimes)

## Why this description sucks

### It paints an incomplete picture of why lifetimes exist

Let me make this clear:  **Lifetimes in Rust prevent more than just dangling pointers.**  I cannot say this enough, in part because the term "lifetime" is *toxic;* it begs people to only think about use-after-free.

I would argue that, in reality, *use-after-free doesn't even need to be an explicit consideration.*  First and foremost, **the purpose of lifetimes is to prevent aliasing,** i.e. that any mutable borrow pointing to data must be unique.  I mean, this is *the* killer feature of Rust; the one that makes all of its other killer features possible!

Think about it!  `<[T]>::copy_from_slice`, a *completely safe function,* is implemented as a `ptr::copy_nonoverlapping`; i.e. a `memcpy` rather than a `memmove`!

No, really, *think about it!*  Rust lets you take a mutable reference to a primitive machine integer and send it off to another thread, yet is able to *statically guarantee* that there are *no data races in safe code:*

```rust
extern crate crossbeam;

fn main() {
    let mut i = 0;
    crossbeam::thread::scope(|scope| {
        i += 2; // okay
        
        scope.spawn(|| {
            i += 2;
        });
        
        // no data races!
        // i += 2; // error[E0506]: cannot assign to `*i` because it is borrowed
    }); // thread is implicitly joined
    i += 2; // okay
    assert_eq!(i, 6);
}
```

And it does all of this based solely on local reasoning within a *single function's body,* using only the signatures and impls of types, traits, and functions used immediately in that function body.[^send-sync]  Wouldn't you suppose that those lifetimes must contain just *a wee bit* more information beyond simply the point in time when a value is destroyed?

[^send-sync]: Or at least, this used to be true.  Now that we have existential types, I think there's some technicality that auto traits like `Send` and `Sync` are automatically leaked without explicit annotation, which I guess could be regarded as requiring analysis of another function body...

### `'static` is not forever... or is it?

We say it all the time, but deep down inside we *know* it ain't true!  **Things that are `'static` do not necessarily live forever!**  `'static` really seems to be this bizarro lifetime... it's not *really* forever, it's just... *longer than this function! (uh... and any lifetimes in its signature. That too!)*

Alternatively, one might argue that perhaps `'static` *is* forever, and that perhaps it is our understanding of `T: 'a` that is wrong.  This is to say; maybe `String: 'static` doesn't mean that *all* `String`s live forever; but rather, that `String`s are *capable* of living forever, since they own their data.  In other words, `T: 'a` describes an **upper bound** on the lifetime of values of type `T`.

I'll admit, it doesn't sound unreasonable.  So, let's take that idea and give it a test run.

**Example 1:**
```rust
struct Struct(Vec<i32>);

impl Struct {
    fn iter(&self) -> impl Iterator<Item=i32> + 'static {
        // error: cannot infer an appropriate lifetime
        self.0.iter().cloned()
    }
}
```

This gives an error, though the precise details of the error differ by compiler version and with/without NLL; we won't fret about them because the real question is, *does it make sense for an error to occur in our revised mental model?*

Let's see... we say that the output type is `impl Iterator<Item=i32> 'static`, which is a type that satisfies `Self: 'static`. In other words, we are promising that the output type is allowed to live forever.  However we are borrowing from `&self`, which has any arbitrary lifetime `&'a`, so in reality our output can live no longer than `'a`.  Okay, seems legit.

**Example 2:**
```rust
impl Struct {
    fn iter<'a>(&'a self) -> impl Iterator<Item=i32> + 'a {
        self.0.iter().cloned() // okay
    }
}
```
This time, we say that the output is a type which satisfies `Self: 'a`.  Okay; we can indeed promise that it *can* live this long.

**Example 3:**
```rust
impl Struct {
    fn iter<'a>(&'a self) -> &'a (impl Iterator<Item=i32> + 'a) {
        // error[E0597]: borrowed value does not live long enough
        &self.0.iter().cloned()
    } // temporary value only lives until here
}
```
Okay, so now we're trying to return a borrow of a temporary inside the function body.  Even though we know that the *maximum* lifetime for values of this type is `'a`, this fails because the maximum lifetime... or, erm... I guess just *the* lifetime for *this particular value* is less than `'a`.

...right.

**Example 4:**
```rust
fn call_iter<'a, T>(
    thing: &'a T,
    func: impl FnOnce(&'a T) -> Box<dyn Iterator<Item=i32> + 'a>,
) -> Box<dyn Iterator<Item=i32> + 'a>
{ func(thing) }
```
...okay, so this one is similar to before except that we now have a `&'a T`, which means that we also know that `thing` must outlive `'a`.  Er, I mean, that values of type `T` are theoretically capable of living for at least `'a`. Or, um.... nope, never mind, it's gotta be the first one, because... **_arghhh!_**

The thing is, talking about theoretical maximums like this is... well, it's *weird!*

I mean, like, when you have two theoretical maximums that apply to something, do you take the minimum or the maximum?  I guess it depends on whether we're talking about proven facts of a type, or about obligations to be fulfilled...  but what does it even *mean* to have an obligation regarding a "theoretical maximum lifetime?!"

## To be continued

Hopefully I have convinced you that there is something... *off* about the way we normally talk about lifetimes.  And even if not, that's okay; the goal of this post was mostly introduction, and to sow the seeds of doubt.

Stay tuned, because many questions remain, with exciting answers to be revealed:

* **What does `'a` _intuitively_ represent?**
* **Do *individual values* have lifetimes, or is everything embodied in the type?**
* **When _exactly_ does some arbitrary type satisfy `Foo<'a, B>: 'p`?**
* **Why is the blog series called "Lockout?"**
* **Who is writing these questions?!**

**Update:** [Part 2 is out!][Part 2]

## Thoughts? Corrections?

I'm trying to get [staticman](https://staticman.net/) set up for comments, but it doesn't seem to be acknowledging my Github invite at the moment.  For now, you can comment on [this URLO thread](https://users.rust-lang.org/t/blog-post-lockout-everything-you-know-about-lifetimes-is-wrong/20483).

---

<!-- FIXME should instead do this by sticking something into the `footnotes` div directly, through... hell, I dunno. JS? CSS? -->
## Foodnotes

{% include series/lockout-links.md %}
