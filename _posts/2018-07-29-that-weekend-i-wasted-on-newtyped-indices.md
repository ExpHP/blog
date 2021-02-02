---
layout: post
title:  "That weekend I wasted on newtyped indices"
subtitle: "a war story"
date:   2018-07-29 20:00:00 -0400
categories: rust
---

Today, ajyne posted a thread on users.rust-lang.org asking: **[What have been the drawbacks of static typing for you?](https://users.rust-lang.org/t/what-have-been-the-drawbacks-of-static-typing-for-you/19172)**

Kornel was quick to reply with a variety of points, but this one in particular stands out to me:
> With powerful type systems there’s no end to how far you can go to guarantee things about your program, but you might create a complex monster.

As I see it, there is no truer answer.  The type system can be a seductive beast, often promising correctness and performance at the low-low, one-time cost of *your soul.*  I personally can name a number of examples from my own code base where I tried to abstract over something too big and failed.

I call these my **wasted weekends.**

## Wasted weekends

I call them "wasted weekends" because that's exactly what they were.  I'd have an idea late on a friday afternoon, and work on it furiously all through the entire weekend.  Come next Monday, I'd be looking at this horrible monstrosity wondering how it ever ended up like this, and my only recourse would be to `git checkout master` and never look at it again.

Many, many ideas have fallen the way of the wasted weekend, like:

* That one time I tried to introduce statically-typed units of measure
    * ...and the second time.  Or the third...
* My first attempt to introduce a wrapper type around `[T; 3]` designed for linear algebra applications
    * and also a time or two where I tried to adopt `nalgebra`, whose API I could never figure out
    * eventually one weekend I *finally succeeded*. (at introducing my own types.  Not at using `nalgebra`)
* That time I tried to give cartesian coords and fractional coords separate types
* That time I took some API that currently takes an `HList` of `Option<Vec<T>>` and tried to introduce typelevel `Option`s so that it could statically produce `None` or `Some`.
    * I called the branch `ev-analysis-crazy`, *a vast understatement.*

Judging from my git logs, about 4 such weekends ended in failure for every one that has succeeded.  And that's only counting ones I saved to named branches. Who knows how many are just anonymous git stashes, or how many were simply deleted...

How come these so often fail?  Well, there's always the usual suspects:

## General problems

There are some problems that very broadly apply to virtually any kind of specialized type or generic abstraction that you can introduce into a codebase:

* **Coupling:** If it appears in your public signatures, then code that uses your code needs to know about it.  People that use your code need to learn what it represents.  The cumulative effect of all of this is that each new type or abstraction that appears in a public API makes it feel *heavier,* makes it more difficult to reuse in a different codebase, and makes it less attractive if factored out and published to crates.io.
* **Interoperability:** *Your new toys won't necessarily play very well with all of your old toys.*  Especially in rust with the coherence rules, generic APIs can only do so much.  In some cases you may need to write compatibility shims, and in some cases you may not be able to use certain things together at all.

Ultimately these are both different manifestations of the same, fundamental, unavoidable trade-off of correctness.  You wanted the compiler to force you to be correct, and *now that is exactly what the compiler is doing!*[^nominal] It's just that, sometimes, this is a lot more work than expected.

[^nominal]: Some of the issues with generic abstractions are partly due to rust's nominal (i.e. locally-checked) type system, and are less problematic in C++'s structural (i.e. duck-typed) type system.  I still prefer rust's system, as I believe it is easier to debug flaws in the design of the abstraction when there's no "bugs at a distance."

## A particular example: Newtype Indices

Allow me to roll the calendar back a couple of months to visit one particularly memorable example.  On the weekend of Friday, May 11, I attempted to introduce newtype indices into my 26kloc[^kloc] codebase.

[^kloc]: Counted using `wc -l`, so this is of course a dire overestimate.

## The "problem"

I use the struct-of-arrays layout a lot in my code; not for performance concerns, but because I find it often makes data dependencies in the code a lot clearer, and makes it easier to work with things that might not be there (e.g. I can have an `Option<Vec<T>>` instead of an `Option<T>` field on some composite type).

But it brings with it a distinct and obvious downside (guess!):

```rust
impl ForceConstants {
    /// Compute a force constants matrix containing only those rows
    /// necessary to generate the full dynamical matrix, given the
    /// spatial symmetry of the structure.
    pub(crate) fn compute_required_rows(
        displacements: &[(usize, V3)],  // (index in supercell)
        sparse_forces: &[BTreeMap<usize, V3>],
        cart_rots: &[M33],
        deperms: &[Perm],  // (permutations of supercell)
        sc: &SupercellToken,
    ) -> FailResult<Self> {
        ...
    }
}
```

In the arguments to this function there are four slices, but **the second two are indexed by different things from the first two**—not that you can tell from looking at it! Not only that, but in code that uses this function, I am dealing with two different atomic structures (a primitive cell, and a larger "supercell") and hence there are *two different ways to index atoms.*  Thus, on the margin, I found it necessary to clarify that the indices in `displacements` and the permutations in `deperms` operate specifically on the supercell.

Stuff like this is ubiquitous throughout my codebase, and I always wanted to do something about it.

## The "solution"
Enter newtyped indices.  `rustc` has a type it uses which is [a vector with a custom index type](https://github.com/rust-lang/rust/blob/75af9df71b9eea84f281cf7de72c3e3cc2b02222/src/librustc_data_structures/indexed_vec.rs).  I copied this into my codebase and adjusted it a bit for my purposes, marking `Idx` unsafe, stripping away `u32` support, and adding support for slices:

```rust
/// Represents some newtyped `usize` wrapper.
///
/// # Safety
///
/// All implementations must guarantee the following properties, else behavior
/// is undefined:
///
/// * `new` and `index` are identical in behavior to `mem::transmute`.
/// * Methods of `Clone`, `PartialEq`, `Eq`, `PartialOrd`, `Ord`, and `Hash`
///   behave identically to how they would for usizes.
/// * `Debug` impls do not panic.
pub unsafe trait Idx
    : Copy + 'static + Eq + Debug + Display + Ord + Hash + Send + Sync
{
    fn new(idx: usize) -> Self;
    fn index(self) -> usize;
}

/// A Vec or slice that uses newtype indices.
///
/// `V` is only ever `[T]` or `Vec<T>`.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct Indexed<I: Idx, V: ?Sized> {
    _marker: PhantomData<fn(&I)>,
    pub raw: V,
}
```

With that, the above signature might look like:

```rust
impl<PrimI: Idx, SuperI: Idx> ForceConstants<PrimI, SuperI> {
    /// Compute a force constants matrix containing only those rows
    /// necessary to generate the full dynamical matrix, given the
    /// spatial symmetry of the structure.
    pub(crate) fn compute_required_rows<DispI: Idx, OperI: Idx>(
        displacements: &Indexed<DispI, [(SuperI, V3)]>,
        sparse_forces: &Indexed<DispI, [BTreeMap<SuperI, V3>]>,
        cart_rots: &Indexed<OperI, [M33]>,
        deperms: &Indexed<OperI, [Perm<SuperI, SuperI>]>,
        sc: &SupercellToken<PrimI, SuperI>,
    ) -> FailResult<Self> {
        ...
    }
}
```

Now, I'm going to be honest.  Making these changes to my codebase felt *positively divine.*  Seeing the index types laid out like this helped to clarify my reasoning a thousandfold.  It was amazing to see the existing implementations of things like `Perm` (a type representing a way to permute a vector) continue to work with little modification beyond function signatures:

```rust
impl<Src: Idx, Dest: Idx> Perm<Src, Dest> {
    /// Compute the `Perm` that, when applied to the input slice,
    /// would sort it.
    ///
    /// The output index type is newly synthesized.
    pub fn argsort<T: Ord>(
        xs: impl AsIndexed<Index=Src, Elem=T>,
    ) -> Perm<Src, Dest> {
        let xs = xs.as_indexed();
        let mut perm: Indexed<Dest, Vec<Src>> = xs.indices().collect();
        perm.raw.sort_by(|&a, &b| xs[a].cmp(&xs[b]));
        unsafe { Perm::from_raw_unchecked(perm) }
    }

    // ... somewhere down the file ...

    /// Get the inverse permutation
    #[cfg_attr(must_use = "not an in-place operation")]
    pub fn inverted(&self) -> Perm<Dest, Src> {
        // "cute"
        Perm::argsort(&self.0)
    }
}
```

IIRC, in the process, I even found one bug!

## Problems created by the solution

### Iterators

The `IndexVec` type used by rustc includes custom methods for producing enumerated iterators, but does not otherwise do anything very special with iterators.  The end result is that **using iterators with `IndexVec` requires giving up type safety of indices:**

```rust
// nothing prevents you from zipping vectors with mismatched indices
let a = IndexVec::<A>::new();
let b = IndexVec::<B>::new();
let zipped = a.into_iter().zip(b);

// constructing one from an iterator will produce any index type
// out of thin air
let a = IndexVec::<A>::new()
let b: IndexVec<B> = a.into_iter().collect();
```

**_Theoretically,_ this problem is solvable.** You can make your own trait:

```rust
pub trait IndexedIterator: Iterator {
    type Index;

    fn zip_indexed<I>(self, other: I) -> Zip<Self, I>
    where I: IndexedIterator<Index=Self::Index>,
    { self.zip(other) }

    fn collect_indexed(self) -> Indexed<Self::Index, Vec<Self::Item>>
    { self.collect() }
}
```

and implement it on a bajillion iterators from `std`, `itertools`, and `rayon`.  Then, instead of using `.zip()`, you use some n-ary `zip!`utility macro that expands to calls of `zip_indexed` and `map`.

I've thought of this many times, and have considered *doing* it many times, and it is only with great restraint that I have managed not to yet.  Perhaps one day in the future, in a moment of weakness, I may give in to the temptation, but when I do so, I will no doubt regret it as I discover yet another problem.

More importantly, **for now, I am adequately serviced by a simple run-time check:**

```rust
pub(crate) fn zip_eq<As, Bs>(a: As, b: Bs)
    -> iter::Zip<As::IntoIter, Bs::IntoIter>
where
    As: IntoIterator, As::IntoIter: ExactSizeIterator,
    Bs: IntoIterator, Bs::IntoIter: ExactSizeIterator,
{
    let (a, b) = (a.into_iter(), b.into_iter());
    assert_eq!(a.len(), b.len());
    a.zip(b)
}

macro_rules! zip_eq {
    ... // (take n expressions, zip_eq them and map to a flat tuple)
}
```

For me, this is sufficient because it is rare for two different index types to correspond to the same length.  So I use `zip_eq!` religiously, and what makes it even better than `IndexedIterator` is that it works just as well on code that hasn't adopted newtype indices.

### Direct sums and direct products (a.k.a. bad ideas beget more bad ideas)

Here's a wild one.  Suppose that I completely lost my mind and actually went through with implementing index types on iterators.

* What is the output index type of `Iterator::chain`?
* What is the output index type of concatentating two `IndexVecs`?
* _Wouldn't it be cool[^wouldnt] if they were the same type?_

Likewise, my `Perm` struct has a function that computes the outer-product of two permutations; given two perms `outer` and `inner`, it constructs the permutation that takes blocks of size `inner.len()`, permuting each block by `inner`, and permuting the blocks themselves by `outer`.  *Wouldn't it be cool* if permutations produced via outer-product had index types that were compatible with `Iterator::flat_map`?

Technically, they *can* be!  These recurring patterns correspond to simple mathematical concepts that form an algebra[^algebra]:

* The **direct sum** of two index types is a new index type isomorphic to `Either<I, J>`.  It represents the concatenation of two vectors.
* The **direct product** of two index types is a new index type isomorphic to `(I, J)`.  It represents nested iteration like `flat_map` and outer products.

So *all we gotta do* is encode these concepts into the type system, and create types to represent them that implement `Idx`! Except... oh, that's right.  `Idx` currently assumes the index can be represented as a single `usize`.  I guess we need to restructure it to no longer involve newtype wrappers, and to instead be represented by a wrapper struct with `PhantomData` tags, and then we can probably—

**NOOOPE!!! No no no no no, stop thinking about it THIS SECOND!**  It won't get you anywhere.  It won't make your code better.  It won't prevent any bugs.  It is nothing but an exercise in mental masturbation.  So **stop it. _Now._**

...yeah, alright. I admit it.  It's a bad idea.

[^wouldnt]: "Wouldn't it be cool..." is perhaps the single clearest indication that you should probably stop thinking so hard about things and start being pragmatic.
[^algebra]: Scratch the prior footnote. The phrase "an algebra" is far worse.


### Supporting code that hasn't adopted newtype indices

When I tried to incorporate newtype indices everywhere, I wanted to make sure they could be **gradually adopted.**  I.e., I wanted to be able to change small, localized portions of the code over at a time without having a wide-reaching impact all over the code base.  This was to ensure that my efforts did not just amount to another "wasted weekend;" come Monday, I'd still have a perfectly-working code base and I wouldn't need to git stash anything.

But how should I do it?

#### Top-down gradual adoption

One thing you can do is start with the highest level code and introduce newtype indices there.  But this is difficult.  If you introduce newtype indices in the highest level code first, you'll just repeatedly run into things that don't yet support them, and you'll be forced to either update those things, or to temporarily throw away that type information.

Actually, this problem exists in my current codebase, where I foolishly *have* introduced them from the top down in some places.  That `ForceConstants` thing I mentioned earlier?  Its current implementation wraps everything in newtyped indices internally, because I have six different index spaces there and it was just too much to mentally bear.

Working with things like `Perm` that *haven't* been converted in the current codebase requires throwing away type information. To combat this, I have a bunch of trivial helper functions:[^deperm]

[^deperm]: Don't ask me what a depermutation is.  Seriously.  You'll regret it.

```rust
impl ForceConstants {
    ...


    // --------------
    // helpers that wrap methods with newtyped indices

    fn oper_indices(&self) -> impl Iterator<Item=OperI>
    { self.super_deperms.indices() }

    // depermutations in the form of a function that maps sparse indices
    fn rotate_atom(&self, oper: OperI, atom: SuperI) -> SuperI {
        let deperm = &self.super_deperms[oper];
        SuperI::new(deperm.permute_index(atom.index()))
    }

    // (note: lattice_point is wrapped into the supercell)
    fn atom_from_lattice_point(
        &self,
        prim: PrimI,
        lattice_point: V3<i32>,
    ) -> SuperI {
        let s = self.sc.atom_from_lattice_point(prim.index(), lattice_point);
        SuperI::new(s)
    }

    ...
}
```

Worse, suppose that I later decide to finally update one of these lower APIs.  Then I need to revisit the higher-level code to remove these hacks, and I must do so *carefully* to ensure I don't leave behind WTF-ery like

```
let index = prim.index();

...

let x = slice[PrimI::new(index)];
```

So really, top-down adoption doesn't work.

For that reason, in my initial attempt to introduce newtyped indices, I began from the bottom up.

#### Bottom-up gradual adoption

Adoption from the bottom-up *is* possible, so long as you can ensure that all previously written code still compiles.  So that's what I did, by introducing a trait with a couple of impls and one or two associated items to bridge between `[]/Vec` and `Indexed`.

_...yeah, right!_

No, I introduced **six (!!!) traits** with a plethora of impls.  One of them uses `()` as a dummy Self type, and another one very emphatically says *please don't use this!*  It's the kind of garbage [you need to see](https://gist.github.com/ExpHP/811e7a650754dc87ebe5d263cf8bef4d) to believe.

With these traits in hand, I was successfully able to upgrade ubiquitous types like `Perm` and `Coords` to be generic over index types without having to touch a single line of high-level code that uses them.

And it was easy! All I had to do was **render all of my function signatures incomprehensible,** and **bifurcate the API in every place where I used to return `Vec<T>` or `&[T]`:**

```rust
// was:
impl Layers {
    pub fn by_atom(&self) -> Vec<Layer>
    { ... }
}

// now:
impl<I: Idx> Layers<I> {
    // For use in code with a fixed index type.
    //
    // This one returns Vec for I=usize, and IndexVec otherwise.
    pub fn by_atom(&self) -> OwnedType<I, Layer>
    where (): IndexFamily<I, Layer>,
    { <()>::owned_from_indexed(self.by_atom_indexed()) }

    // Non-IndexFamily version, for use in code generic over I: Idx
    //
    // This one always returns IndexVec.
    pub fn by_atom_indexed(&self) -> Indexed<I, Vec<Layer>>
    { ... }
}
```

Yikes.

B-b-but, no worries right? It's only temporary, right?  Once I migrate all of my code to use newtype indices, I'll be using `Indexed<_, Vec<_>>` everywhere and so `by_atom_indexed` is the only one I'll need, right?  I'll be able to get rid of all the traits and bifurcation, and live happily ever after.  _Right??_

Well, unfortunately... **maybe I don't _want_ to convert _everything_.**

#### It's not just temporary

Remember the issue of coupling?  Here's the thing.  Maybe, *just maybe,* I would like for some of my code to one day be useful for another being on this Earth. For that to happen, I have to make people *want* to use it.  And for *that* to happen, people need to be able to look at the signatures of my public API and feel vaguely at home.

Most people won't want to have to think so hard about index types, and so having this weird `Indexed` thing all over the place would doom its adoption.  Thus, I am reluctant to introduce `Indexed` into things that I potentially want to factor out into a public crate.

And so it seemed that some non-Indexed code was here to stay, and hence these awful generic APIs and the bifurcation would remain necessary **forever.**

After I realized this, that was the final straw; next Monday, I left it all to rot in an abandoned git branch, and resumed working largely without them.

## Solutions that don't rely on the type system

Even though it clearly takes far too much effort to thoroughly adopt them, the exercise of *attempting* to adopt newtype indices was an incredible learning experience.  I may have given the wrong impression by focusing on all of the negatives above, but **in reality the index types were wildly successful at describing common usage patterns in my code.**

Some types like `Perm` and `SupercellToken` above gained two index types, and it suddenly became clear to me that they had the properties of mathematical categories. Common mistakes I might make when working with sparse representations vanished as it became unbearably clear that the indices in dense and sparse representations play different roles (similar to covariance versus contravariance).

Though I have given up on enforcing these things *at large,* the majority of my code can still benefit from the lessons learned through other means:

* Using index types as a tool for *reasoning* (mentally!) about code.
* Following naming conventions and/or adding comments that clarify index spaces.
* Runtime checks like `zip_eq` above.

I know that second bullet point may shock a number of people.  Variable names can be wrong; comments can be out of date; this is why we have a type system, after all!

And I agree!  ...But as far as I can tell, I have taken the pragmatic option.

<!-- FIXME should instead do this by sticking something into the `footnotes` div directly, through... hell, I dunno. JS? CSS? -->
## Phootnotes
