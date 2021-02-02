---
layout: post
title:  "Lockout, Part 5: Valuable lifetimes"
date:   2018-10-17 18:00:00 -0500
categories: rust series
# used for ToC generation
series: lockout
series-part-id: 5
---

This is part of a blog series on working towards an intuitive mental model for lifetimes in Rust.

{% include series/lockout-toc.html %}

---

> Like other posts in this series, this is a learning experience that I am sharing with you.  On occassion, I deliberately leave in bad ideas---mistakes that I myself made---so that they can be shot down later.  Even the most obvious and uncontroversial statements may later prove to be false, so be sure to arm yourself with a healthy sense of skepticism!
>
> Why do I bring this up now?  Well... let's just say that, today, perhaps, I might be doing it *a bit moreso* than others.

Today is a special day!  By finally introducing lifetime annotations---even in the simplest form that one possibly can think of---we will uncover a surprising truth about lifetimes in Rust that few of us would have anticipated.

We'll be adding them to the simple borrow checker introduced in Parts 2-4.  If you're just joining us now, I recommend you read [Part 2][Part 2] and/or the review at the beginning of [Part 3][Part 3], which introduce a lot of the concepts and terminology I will be using; the rest is not essential to follow this post.

In fact, we're going to basically drop all modifications that have been made to the rules since the beginning of Part 3, and only bring them back if they are seen as necessary again.  There's simply no easy way to tell in advance how much of that complexity will become redundant in the face of lifetimes.

## Our place in the grand scheme of things

> **Caution:** I am very much __not an expert__ on this topic.
>
> Please take what I say here with a smattering of salt and pepper!

Here is how I envision the process of compiling a file in rust.  This description was written with much help from the wonderful [Rustc guide](https://rust-lang-nursery.github.io/rustc-guide/), but may still contain errors:

* **Parsing to AST and HIR** --- I'm grouping together a surprisingly large number of steps here that we don't really care about. This includes [*two* separate parsers](https://github.com/rust-lang-nursery/rustc-guide/blob/ceff08f6b3f9666489be7ecd417b066e117aa474/src/macro-expansion.md) and is inexorably coupled with macro expansion.

* **Type checking** --- This is a multitude of intertwined components---type inference, trait solving, type checking, and method resolution---that run on the HIR, determining the types of all values in each function body.  Lifetimes have extremely little effect on this, if any.[^lifetime-trait-solving]

  This also includes a largely independent pass over all type definitions to [determine the variance of all struct type parameters](https://github.com/rust-lang-nursery/rustc-guide/blob/master/src/variance.md).

  By the end, the type associated with each value in a function body will have a set of undetermined "region variables" associated with it, and [constraints on these variables](https://github.com/rust-lang-nursery/rustc-guide/blob/ceff08f6b3f9666489be7ecd417b066e117aa474/src/type-inference.md#region-constraints) will be known.

* **Lowering to MIR** --- The HIR of each function body is lowered to a control flow graph.

* **Borrow checking** --- **That's us!** --- The MIR is traced to determine where loans (or, in our case, *locks*) are created and released, in order to search for conflicts. This search is enhanced using information from the type checker about lifetime variables and constraints.

* **Translation** --- Functions without type parameters (as well as the specific instances of generic functions used by them) are identified in a process called monomorphization, and the monomorphized functions are lowered to LLVM IR. Lifetimes play no role here.

There's something critically important I want you to recognize in the above graph:  **Borrow checking is NOT actually part of type checking!**  It is completely finished by the time we get to work!...[^lifetime-inference] but it has also already done a lot of work for us that used to be *our job;* work that can solve a great deal of the problems we've been repeatedly running into, such as refined knowledge about locks held by fields, and silly problems like locks held by machine integers.

[^lifetime-trait-solving]: I was messing around in the playground trying to figure out if it was possible to write two trait overlapping impls that become disjoint if the lifetimes were written differently.  As far as I can tell this is not currently possible.

[^lifetime-inference]: By which I mean, all information is known *up to* lifetimes.  That said, borrow-checking may involve a step called "lifetime inference," where we propagate the information stored in the region variables by solving the region constraints in a manner that *could* resemble type inference.

Now, if you ask me, I don't *want* to just take everything rustc's type system can give us for free quite just yet.  It'd make things boring and we would hardly learn anything!  That means **the type system aspects ought to be part of our responsibility as well.**

...but that's all in the future!

We'll still be focusing on values today.

## Lifetime annotations on values

> B-but I thought we were doing lifetimes today...?

Welllllll... we are! Sort of.

I meant precisely what I said at the beginning of this post: we will be introducing lifetime *annotations.*
It is understandable if you're confused; up to this point in the series, I've been using the term "lifetime" to refer almost exclusively to *borrow-checking information embedded into the type system.*  And my original intent certainly was to do exactly that.

...until I accidentally invented **lifetime annotations _on values._**

How does that happen, exactly? Turns out it's surprisingly easy; you just say: *I'm gonna make a new type constructor for annotating the locks held by a type!*

```rust
// allows us to write lifetime annotations on arbitrary types
macro_rules! Val {
    ($Ty:ty) => { $Ty };
    ($Ty:ty, $($tts:tt)*) => { $Ty };
}

// allows us to name the lock created by a borrow expression
macro_rules! lock {
    (&$lt:lifetime $expr:expr $(,)*) => { &$expr };
    (&$lt:lifetime mut $expr:expr $(,)*) => { &mut $expr };
}
```

> **Notice:** These `Val!` and `lock!` macros don't actually do anything!  The only reason they're even here is so that I can put my examples in rustc to check for certain kinds of typos.  Examples that use these macros may have completely different borrow checking behavior in rustc (and for some examples, it may even fortuitously be the same!).

...but then to keep things simple, you add: *and it can only be used as the outermost type constructor!*

What you end up with is a notation that looks suitable for something very similar to our value-based borrow checker from parts 2-4, with only a small number of notable differences.  Let's talk a bit more about this notation before talking about how to implement a borrow checker that uses it.

### Lifetimes as individual locks

We will now religiously annotate locks held by values using the `Val!` macro.

Here's some values with no locks. In this case, we just write `Val![T]` with no other arguments.

```rust
let one: Val![i32] = 1;
let two: Val![i32] = 2;
```

`&` and `&mut` expressions must now be written using the `lock!` macro to name the lock that is created. To make examples easier to follow, we'll use a simple naming convention:

* A write lock on `some_identifier` will be called `'some_identifier_w`
* A read lock on `some_identifier` will be called `'some_identifier_r`
* If necessary, integers may be appended (e.g. `_r1`, `_r2`) for disambiguation.

```rust
let borrow_1: Val![&i32, 'one_r] = lock!(&'one_r one);
let borrow_2: Val![&i32, 'two_r] = lock!(&'two_r two);
```

When something holds multiple locks, we'll separate them with `+`.

```rust
let branch: Val![&i32, 'one_r + 'two_r];

branch = match today_is_tuesday() {
    true => borrow_1, // (1)
    false => borrow_2,
};
```

The lifetime annotations chosen here simply denote the behavior of our value-based borrow checker from prior episodes.  At (1), it may appear superficially that we are assigning a value of type `Val![&i32, 'one_r]` to a different type `Val![&i32, 'one_r + 'two_r]`, but in reality these lifetimes are a separate channel of information and not part of the type (which is `&i32` in both cases)...  for the moment, at least.

Similarly, here's how we might write a tuple:

```rust
let tuple: Val![(&i32, &i32), 'one_r + 'two_r];

tuple = (borrow_1, borrow_2);
```

Contrast with standard Rust, where you would annotate the individual borrows in the tuple.  Here, we must provide a single annotation for the tuple as a whole, because that is what meets our definition of a *value.*

One thing we won't be considering for now is loops.  See the following:

```rust
let mut int = 3;
let mut v = vec![];
for _ in 0..3 {
    v.push(lock!{&'int_w mut int});
}
```

This is an example where a lock named `'int_w` conflicts with another lock named `'int_w`, both produced by the same line on different iterations of the loop.  Trouble is, the whole point of the `lock!{}` macro was to make it easy to talk about conflicting locks by giving each one a unique name!  That, and... loops actually look challenging to handle correctly anyways, so it'll be better to save them for later.[^name-termination]

[^name-termination]: These loops would somehow need to be handled in such a way that all borrow expressions are still guaranteed to generate a finite number of distinct locks.  Otherwise... the proof of termination for my lifetime inference algorithm will no longer hold.

### Lifetimes as sets of locks

Let's call a function.  (About time, right?)

```rust
fn a_function(borrow: &i32);
```

Hang on, all top-level types should be using `Val`!  Let's fix that.  But what locks does the input hold?

Remember, a single `&i32` can be holding any number of read-write locks, much like `branch: Val![&i32, 'one_r + 'two_r]` in the previous example.  I doubt it'd be worthwhile to introduce some notation for "variadic" lists of locks, so we'll introduce a single lifetime `'from_borrow` that represents all of the locks held.[^suffix-lifetime-set] From this point onwards, a lifetime may, in general, represent any number of locks.

[^suffix-lifetime-set]: I purposefully used a different naming scheme (rather than introducing another suffix like `'borrow_a`) to help make things less confusing.  The distinction is that `'borrow_r` and `'borrow_w` are locks _of_ `borrow`, while `'from_borrow` is a lock _held by_ `borrow`---very different things!

```rust
fn a_function<'from_borrow>(borrow: Val![&i32, 'from_borrow]);
```

About the output type... we can just say that a function with no output type now technically desugars to `-> Val![()]` rather than just `()`.

### "Lock sets" versus "lifespans"

Throughout this post so far, I have been using the term "lifetime annotation" to refer to `'a`, and the term "lifetime" to refer to the borrow-checking information associated with `'a`---whatever that information is.  However, "lifetime" is a pretty loaded term, and there will be times when I feel that using it may create unnecessary confusion.

For when the distinction becomes necessary, I introduce two new terms to help differentiate our lifetimes from Rust's:

* Our borrow checker's lifetimes shall be called **lock sets.**
* The lifetimes in standard Rust shall be called **lifespans.**

### The `'static` lifetime

Now that lifetimes are sets of locks, we can also name the empty set.  If you've been following along, then I hope the following choice of name does not surprise you:

**We shall call the empty set of locks `'static`.**

A `Val![T, 'static]` is a value that can be freely used anywhere and returned from any function---just like `'static` values in Rust---because it holds no locks.

### Limitations old and new

Consider a function like this:

```rust
fn triple_trouble(a: &i32, b: &i32, c: &i32) -> &i32;
```

Up until now, a function signature like this was entirely opaque to us.  If we ever tried to call one, we would be forced to assume the absolute worst.

What is the "absolute worst?"  I've never really stated it explicitly until now, but there is a core principle of our lock-based system which has guided a great many of the design decisions made up to this point, and I'd like to give it the explicit mention it deserves for once:

Basically, **it is always safe to assume that a value holds more locks than it actually does.** Locks represent purely negative capabilities; expressions and statements which are no longer allowed to appear at a given point in a function body because they would produce a conflicting lock.

> **Note:**
>
> To support this reasoning, we shall _never, ever, **EVER**_ try to argue that some statement in a function ought to be permitted _"because `x` has locked `y` for writing."_  At least, this kind of reasoning belongs in libraries that provide unsafe abstractions---not in the borrow checker.
>
> Please call me out if I ever break this promise!

Thus, the safest assumption is always that the output holds every lock it possibly can:

```rust
// our old borrow checker's assumption:
fn triple_trouble<'from_a, 'from_b, 'from_c>(
    a: Val![&i32, 'from_a],
    b: Val![&i32, 'from_b],
    c: Val![&i32, 'from_c],
) -> Val![&i32, 'from_a + 'from_b + 'from_c];
```

Now that we have these lifetime annotations, we can try to allow them to guide the borrow-checking process; ideally it should be possible now to explicitly constrain the relation between lifetimes in a function signature.

```rust
// Not formerly possible!
fn only_holds_one<'from_a, 'from_b>(
    a: Val![&i32, 'from_a],
    b: Val![&i32, 'from_b],
) -> Val![&i32, 'from_a]; // no locks from b!

// only one lifetime!
fn sharing_is_caring<'shared>(
    a: Val![&i32, 'shared],
    b: Val![&i32, 'shared],
) -> Val![&i32, 'shared];
```

Because we currently have no form of lifetime inference, we must also be able to use a turbofish to explicitly assign these lifetimes when calling the function: (normally, Rust forbids this!)

```rust
fn please_do_share<'from_a, 'from_b>(
    a: Val![&i32, 'from_a],
    b: Val![&i32, 'from_b],
) -> Val![&i32, 'from_a + 'from_b] {
    sharing_is_caring::<'from_a + 'from_b>(a, b)
}
```

#### Limitations that yet remain

Unless we want to do e.g. the [annotation or auto-trait hacks]({% post_url 2018-10-06-lockout-part-4 %}#declaring-types-that-hold-no-locks) suggested near the end of last episode, we still have the issue that values of any type---even simple machine integers or `()`---may hold locks.  And they *will,* if we try to do something like access a field of a tuple, since we have no fine-grained information about fields.

```rust
// our current borrow checker's conservative assumption
let one: Val![i32] = 1;
let tuple: Val![(&i32, i32), 'one_r] = (lock!{&'one_r one}, 2);
let field: Val![i32, 'one_r] = tuple.1; // integer holding a lock!
```

#### New limitations

In [Part 4][Part 4] we had some cases where locks had to be added to a value after its creation (notably, after mutation of existing values).  These cases will become a lot trickier to talk about, because putting the annotation on the type seems to suggest that it should not change.[^retroactive-update]

[^retroactive-update]: One might suggest that these examples could now retroactively change the set of locks held by a value, so that these new locks are considered to be held from the value's creation.  But it is not so simple; in the case of adding a new write lock `lock{&'int_w mut int}` to an existing value, that would prevent the lock's very creation in our current design, which tests `int` for writing before creating the lock.

We'll hold off on these for now, until we're ready to revisit invariance.

### But this is all so verbose!

Indeed.

For the small amount of additional power this notation may afford us in function calls, all of our code has become a *great significant deal* more verbose.  But consider something like the following, without all of the verbose annotations:

```rust
fn today_is_tuesday() -> Val![bool];
fn its_a_new_moon() -> Val![bool];

fn conditional<'from_cond, 'from_data>(
    cond: Val![&bool, 'from_cond],
    aye: Val![&i32, 'from_data],
    nay: Val![&i32, 'from_data],
) -> Val![&i32, 'from_data];

// how's *this* for contrived?
fn infer_me<'from_a, 'from_b, 'from_c, 'from_thundering>(
    a: Val![&i32, 'from_a],
    b: Val![&i32, 'from_b],
    c: Val![&i32, 'from_c],
    thundering: Val![&bool, 'from_thundering],
) -> Val![&i32, 'from_a + 'from_b + 'from_c] {
    conditional(
        thundering,
        if today_is_tuesday() { a } else { b },
        if its_a_new_moon() { b } else { c },
    )
}
```

If we want lifetime annotations in function signatures to have some authority over borrow-checking behavior, then it must be possible for the borrow checker to validate them against the body of the function and verify that the contract is upheld.  But how is the body of a function like `infer_me` validated?[^not-an-option]

[^not-an-option]: And no, finding the office of whoever wrote this function to deliver a knuckle sandwich is not an option.

We can answer this ourselves.

## Lifetimes on values act as a secondary type system

The lifetimes presented so far in this post are very different from those found in Rust. _Superficially,_ they look like part of the type; but I hope you can see by now that this is merely for notational convenience.  Our notation is always used at the top level of a type, so you cannot put annotations *inside* a type:

```rust
// no such thing in our mini-language
let vec: Vec<Val![&str, 'a]>>;
```

Similarly, in contrast to Rust, type variables cannot "carry" lifetimes with them:

```rust
// In Rust, this can be substituted with `T = &'a i32` for some
//  concrete lifetime 'a.
fn foo<T>(x: T, y: T) -> T;

// For us, that lifetime must come separate.  It need not even be the same
// for all occurrences of the type parameter!
fn foo<'a, T>(x: Val![T, 'a], y: Val![T, 'static]) -> Val![T, 'a];
```

But here's what's funny; even though we are not _truly_ embedding borrow information into types yet, it turns out we won't need to completely eschew the type system aspects of borrow checking.  This is because **in our simplified system of lifetimes, the lifetimes annotations actually form their _own_ little type system,** completely independent of the real type system.

So it turns out that we are still going to get a taste of the type system aspects after all, including subtyping, region variables and even lifetime inference!  Put together, these will make validating functions like `infer_me` possible.

First things first: A notion of subtyping.

### Subtyping relations on lifetimes

Let's make things real simple, and suppose that we're just looking at a statement that assigns some expression to a local with an explicit lifetime annotation:

```rust
let x: Val![_, 'some + 'locks] = { /* some expression */ };
```

What we need to know is:  *When should we accept this statement, and when should we reject it?*

I left the actual type as `_` because it isn't relevant to us. The type checker already checked it, so we know it's good.  And whatever it is, it won't have any effect on borrow checking.[^coercion-assumption]

[^coercion-assumption]: I am assuming that any coercions inserted by the type checker have no influence on the success of type checking.  Strictly speaking, this very well could be incorrect in true Rust, where coercions can change the variance of a type parameter... but I feel pretty confident that it is true in our simplified model.

Obviously, we should accept this statement if the expression holds all of the locks in the set `'some + 'locks`.  But we also know that *it is always safe to assume that something holds more locks than it really does,* and that supporting this is crucial for branching expressions (like `match`).  So this statement must also be fine if the expression holds `'some`, or if it holds nothing (`'static`)... but it is **not fine** if it holds another unrelated lock like `'a`.

**One can view this as a subtyping relation.**  `Val![_, 'locks]` is a subtype of `Val![_, 'some + 'locks]` because any value of type `Val![_, 'locks]` may be regarded as a member of the type `Val![_, 'some + 'locks]`.

Fascinatingly, in our type system, subtypes hold fewer locks than supertypes! This may sound backwards to the trained ear, since normally in type systems, *less is more;* a subtype is normally more specific because it has more functionality!  The reason it works differently for our locks is that, as previously noted, these locks represent "negative capabilities."

### Bringing it home with bounds notation

Now, to be honest, at this point, `Val![_]` is kind of getting in the way of some of the things I'd like to say.  And so I propose: what if we just considered `'some + 'locks` to be *the type itself?*

```rust
let x: 'some + 'locks = { /* some expression */ }; 
```

...okay, maybe that snippet is taking it a bit too far... but I mean, I would *like* to talk about lifetimes as if they were types because that makes it a heck of a lot easier to talk about subtype relations. For instance, we can simply say that "`'some` is a subtype of `'some + 'locks`."  Similarly, we can make this important claim:

* `'static` is the subtype of all lifetimes

More succinctly, we can use that "bounds" notation from Rust, and say that:

```rust
// read as:  SUBTYPE : SUPERTYPE
'some : 'some + 'locks
```

The subtype is the one that appears on the left side of the colon, consistent with its usage in standard Rust.  To remember this, just think of `'static` and ask yourself which is correct: `'static: 'a` or `'a: 'static` (hint: it's not the latter).

## Now about that part where I've been lying to you

This post has already gotten pretty long, but it simply *cannot* stop here, and let me tell you why: **Because there is a crippling flaw in our notation.** We *cannot* continue to use it as is, and I must make amends before it leaves some poisonous imprint on you all Sapir-Whorf-style-like and stuff.

Did you notice the flaw? I can give you a hint that the previous section just barely avoids crashing straight into it, and if you put it together with what you already know about lifetime annotations, you'll likely find that things simply don't *add up.* <!-- Shoot, did those italics make it too obvious? I'm sowwy ;_; -->

I'll give you some time to think, and, I dunno... get a cup of coffee.

## [Intermission](https://www.youtube.com/watch?v=O0wOD9TWynM)

---

Okay. Have you thought about it?

I'll just put a few more inane paragraphs here as spoiler barrier for people who scroll too fast.

Spoiler barrier.  Spoiler spoiler barrier.  Barrier spoiler.

Barrier.  Barrier.

Spoiler barrier.

Spoiler!  Spoiler barrier!!! Barrier?

Barrier barrier barrier, spoiler.

Good night, spoiler. Sweet dreams, barrier.

Berrier barrier burier.

Humpty dumpty sat on a barrier.

Then he spoiled.

...

...don't tell me you use `PageUp`/`PageDn`, do you?

...that's okay. I do too.  You're in good company.

Yep.

Spoiler barrier.

...alright, splendid! I think that's enough spoiler barrier.

---

## The algebra of lifetimes

### What's wrong with our notation?

I want you to consider my recent statement that `'a` is a subtype of `'a + 'b`, and try making a little substitution with `'static`:

**Is `'a` a subtype of `'a + 'static`?**

* **In our notation, yes;** `'a + 'static` is effectively just `'a`.
* **But in regular Rust notation, `'a + 'static` is effectively `'static`!**

Up until now, we've been using `+` to represent something fairly easy to comprehend; `'a + 'b` holds each lock from `'a`, and each lock from `'b`.

...but in regular Rust, when we write `'x: 'a + 'b`, it is equivalent to two individual bounds, `'x: 'a` and `'x: 'b`.  It's kind of like that weird thing about "theoretical maximum lifetimes" that I... may have rambled on about in Part 1.[^dont-bother]  `T: 'a` doesn't necessarily mean that `T` holds all of the locks in `'a`; we just know that it holds *at most* those locks.  When `T: 'a` and `T: 'b`, we know that it holds *at most* the locks in `'a` and *at most* the locks in `'b`.

[^dont-bother]: If you haven't seen it, don't go bother looking for it. Part 1 wasn't exciting. Stay here! This is where you wanna be!!

But guess what?  This actually is a *sensible operation to think about* with regards to our sets of locks, in contrast to when lifetimes were thought to represent the lifespans of values.  We can easily rigorously define this:

### Two lifetime operators: Set unions and set intersections

From now on, we will no longer write the notation `'a + 'b` to denote a lifetime;[^incidental-plus]  In reality, there are two binary operations defined on lifetime annotations, which form ~~an algebra.~~ ~~a ring.~~ ~~a commutative semi[rng](https://en.wikipedia.org/wiki/Rng_(algebra)) where addition distributes?~~ a mathematical something-or-other.

[^incidental-plus]: Mind, in the future it may still appear incidentally in trait bound lists (due to the sugar for writing multiple bounds on a type); but it is not considered to represent a single, composite lifetime.

#### The union operator: `'a | 'b`

From now on, **all of the places where we used to use `'a + 'b` in our made-up notation shall now use `'a | 'b`.**  `'a | 'b` holds all locks held by `'a`, in addition to all locks held by `'b`.

* In our borrow checker, `'a | 'b` is a **union of lock sets.**
* In the type system, `'a | 'b` is a **union of types.**
    * It is a **supertype** of either input.
    * In bounds notation: `'a : ('a | 'b)`.
* **Be careful!** In standard Rust, `'a | 'b` might be regarded as an **intersection of lifespans.** That is, the value must live no longer than `'a` and no longer than `'b`.

For instance:

```rust
// Please forget everything you just saw and
// get used to this notation!
let branch: Val![&i32, 'one_r | 'two_r];
branch = match today_is_tuesday() {
    true => borrow_1,
    false => borrow_2,
};

let tuple: Val![(&i32, &i32), 'one_r | 'two_r];
tuple = (borrow_1, borrow_2);

fn please_do_share<'from_a, 'from_b>(
    a: Val![&i32, 'from_a],
    b: Val![&i32, 'from_b],
) -> Val![&i32, 'from_a | 'from_b] {
    sharing_is_caring::<'from_a | 'from_b>(a, b)
}
```

Here's a surprising fact: There is **no notation at all for this in standard Rust.**

That's right.  Read that again, and re-read the examples above it.  Look at the kinds of things it represents---how *fundamentally important* they are!  The lifetime of a borrow produced by a branch expression.  The lifetime of a tuple.  *You cannot directly express these concepts in the language of Rust.*[^how-we-survive]

[^how-we-survive]: How do we survive without them, then?  That's a question for next time!

`'static` is the identity element of this operation, satisfying `('static | 'a) === ('a | 'static) === 'a` for all `'a`.

#### The intersection operator, `'a & 'b`

For the meaning of `+` that appears naturally in standard Rust, we shall now use `'a & 'b`.  This represents **the set of all read-write locks contained both in `'a` AND in `'b`.**

* In our borrow checker, `'a & 'b` is an **intersection of lock sets.**
* In the type system, `'a & 'b` is an **intersection of types.**
    * It is a **subtype** of either input.
    * In bounds notation: `('a & 'b) : 'a`.
* **Be careful!** In standard Rust, `'a & 'b` might be regarded as a **union of lifespans.** That is, the value must live no longer than `'a` *or* no longer than `'b` *(whichever is more convenient).*

This operator has not shown up anywhere yet in our value-centric design; for now, it is important just to understand that it exists.

`'static` is an "annihilating element" of this operation, satisfying `'static & 'a === 'a & 'static === 'static` for all `'a`.

## In conclusion

Surprisingly, when we put lifetimes on values rather than types, we still end up with some notion of "lifetimes as types"---except that these types now form a completely separate type system!

Thinking of lifetimes as sets of locks very quickly earns us a pair of useful and easily-understandable set operations, and long before we even know it we're already expressing concepts fundamental to borrow-checking that, stunningly, have *no corresponding syntax* in standard rust!

How is this even possible, one might wonder?  My current feeling is that we likely don't *require* this syntax, because lifetime inference already takes care of every possible use case for it.  I may be putting this theory to the test in the next part.

> **A parting word:**  Numerous times on [URLO](https://users.rust-lang.org), I and many others have stated that "values do not have lifetimes, only borrows do." But in our simpler formulation, a value of type `(&'a i32, &'b i32)` (in standard Rust) clearly *does* have a lifetime, which we may express as `'a | 'b`.
>
> Perhaps one could say that it has a lifetime in standard Rust as well... and that we're simply discouraged from talking about it due to our inability to express it!

## To be continued

Till next time, when we implement lifetime inference!

## Comments and corrections

You can keep 'em coming on [this URLO thread](https://users.rust-lang.org/t/blog-post-lockout-everything-you-know-about-lifetimes-is-wrong/20483)!

---

## Fonóta[^translate]

{% include series/lockout-links.md %}

[^translate]: Isn't Google Translate grand?
