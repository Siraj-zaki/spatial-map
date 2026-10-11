# DWG binary format: reader notes

This file is the record of bugs found in `backend/internal/cad/dwg/` — the hand-written DWG reader, built from the ODA's published *Open Design Specification for .dwg files* because every complete alternative is GPL or proprietary (see `docs/cad-import.md` for the licensing doctrine and the rest of the import pipeline). Each section below is a trap that cost days to find.

The one thing to internalise before reading further: **nothing in a DWG states what a coordinate should be**, so `TestEntityDecodeConsumesExactlyTheDataStream` — which asserts that every entity in every fixture lands exactly on `dataStop()` — is the reader's main and very nearly its only proof of correctness. Almost every rule here is either something that assertion caught, or something it is structurally blind to and therefore needs a second, independent check.

The corpus is the other half of the proof. A rule is only as strong as the oldest and the strangest fixture that exercises it, and several sections below exist because a fixture arrived that no previous one resembled.

---

## Container, compression and release support

### Decompress `literalChunks` recursively, not as a flat copy table

**Trap** — reading `literalChunks` in `internal/cad/dwg/compress21.go` as a flat "copy `size` bytes from `index`" table. It is **recursive**: a chunk of *n* bytes is itself laid out by entry *n*, not copied straight through. Entry 23's trailing `{16, 0}` means "apply entry 16 to the first sixteen bytes" (which swaps their halves), not "sixteen bytes from the start".

**Why it hides** — read flat, the decompressor produces output that is the right *length* and passes every structural check, so the failure surfaces far downstream as a corrupt `AcDb:Header` sentinel. The natural next move — patching individual table entries to "fix the spec's typos" — makes it worse, because entries 4 and 8 are correct as written.

**Rule** — entries 1, 4 and 8 are the base cases (the sizes the encoder moves as whole machine words, unpermuted) and are deliberately absent from the table because `appendLiteralChunk` answers them directly in its `switch`. Everything else recurses. Validate against the `headerSentinel` (`CF 7B 1F 23 FD DE 38 A9 5F 7C 68 B8 4E 6D 33 5F`) at the head of `AcDb:Header`, not against output length: length agreeing proves nothing here.

### Resolve every length field against a fixture before building on it

**Trap** — treating a length field in an R2007 DWG as a count of the thing it names. The section map's `nameLen` is a count of **bytes including the 2-byte UTF-16 terminator** — `"AcDb:AppInfoHistory"` (19 characters) reports **40**.

**Why it hides** — read as characters, the reader walks off the end of the map and reports a bogus overrun; read as bytes-without-terminator it desynchronises by two bytes per entry and every subsequent name decodes as garbage. In this format a wrong reading of a length usually still produces plausible-looking bytes rather than an error. Note that the `TU` string type in `bitreader.go` is the opposite convention — a count of **characters** — so the two cannot share a helper.

**Rule** — decode as `utf16.Decode` over `nameLen/2-1` units, then consume the terminator, and guard `nameLen%2 != 0` before doing either. Generally: resolve every length field in this format against a real fixture before building on it.

### Bound the supported release range in one place, and say which way to re-save

**Trap** — refusing an unsupported release with a message that names the release but not the **direction** to re-save, and letting the version→container table claim a family that has no reader. Two halves of one bug, and they hide each other. `"AC1015 is not supported yet"` is a dead end: the user has a file, no next step and a support ticket, when every such case is one Save As away — and *which way* to save is not obvious from a version string nobody reads in hex. Meanwhile `Version.container()` returned `(containerR15, true)` for R13/R14/R2000 while `open`'s switch refused them in a separate arm, so the same refusal came from two branches on different premises and the table read as though those releases were wired up.

**Why it hides** — the corpus is entirely R2004+, so no test exercises the refusal at all, and the constant said "supported" while the code said otherwise.

**Rule** — bound the range as named constants (`oldestSupported` / `newestSupported`), quote them back in the message, and pick the direction by **string-comparing the magic**: DWG magics rise monotonically with release, so even an unrecognised version lands on the correct side (`AC1035` → "newer … re-save as R2018 or earlier"). Make `container()` the single source of truth — a version it names is a version `open` opens, so a family with no reader is simply absent. Hold the two together with a consistency loop over `versionNames` asserting `container()` agrees with the supported range; that is what stops the advice recommending a Save As nobody needs once a container lands. Write the test **fixture-free**: the releases under test are exactly the ones no fixture exists for, which is why they are unsupported, so a test that needed one could never run.

---

## Object framing: prologue, data stream, handle stream

### Measure data length from the prologue, never with a measured constant

**Trap** — measuring an object's data length from the wrong **origin**, then papering over the result with a constant. `bitsize` counts from the first bit past the prologue, not from bit zero of the object. Measured from bit zero, a correctly decoded LINE appears to finish 15 bits *past* where the field says the data ends, and the tempting response is to hardcode the 15.

**Why it hides** — the 15 works on every small object and is wrong on every large one (see the next section), and it permanently hides the real rule behind an "empirically measured" constant nobody can reason about afterwards. The decoder was right the whole time; the *expected landing position* was wrong.

**Rule** — `object.dataEnd()` returns `dataStart + dataBits - 1` for R2007 and below, `dataStart` being `probe.bitPos()` after the prologue and carried on the object — and `totalBits - handleStreamBits - 1` for R2010+, which counts the handle stream instead. Both are the specification read literally; there is no measured constant left in the reader. Don't change either without re-running `TestEntityDecodeConsumesExactlyTheDataStream`, which asserts exact landing for every entity in every fixture; nothing in a DWG states what a coordinate *should* be, so that test is the only proof the layout is right.

Corroborating signals if you ever need to re-derive it: the handle stream after `dataEnd` must be consumed exactly, its layer entry must resolve to a LAYER, and the strings-present flag on the last data bit must read zero for types with no string fields. R2000/R2004 share the pre-R2010 branch; **R2004 is now verified** by `Apartment-1.dwg` (5,751 entities landing exactly), R2000 is not, and `containerR15` can't open one anyway.

### The prologue's size field is an `MS`, so its width is data-dependent

**Trap** — treating the prologue as a fixed length, i.e. assuming the size field is always two bytes. It is an `MS` (modular short): 16 bits for an object under 32 KiB, **32 bits above it**. Assume 16 and `dataStart` is 16 bits low, so the declared end of every large object lands 16 bits early.

**Why it hides** — maximally deceptive. Geometry is read forwards from the start and decodes perfectly; the handle stream is positioned from the *other* end and is also fine; the reader looks entirely correct. It surfaces only where something reads **backwards** from the end of the data — the R2007 string stream — as `object 0x1f claims a 2640-bit string stream ending at bit 353`. Exactly **7 objects in 139,000** across the whole fixture set are large enough to trigger it (BLOCK_HEADER `0x31`, 3DSOLID `0x26`, XRECORD `0x4f`), so a fixture set one drawing smaller would have shipped the bug.

**Rule** — carry the prologue's actual end (`object.dataStart = probe.bitPos()` in `readObject`) rather than computing it, and never re-introduce a constant offset into `dataEnd()`. Generally: when a DWG field is declared modular (`MS`, `MC`) its width is data-dependent, so any arithmetic spanning it must come from a cursor, not an assumption. The transferable lesson is that a forward-only reader cannot detect this class of error at all — `locateStrings`' bounds check is load-bearing precisely because it reads in the opposite direction, so keep it enforced in `readObject` rather than demoting it to a test.

### The R2010+ declared size does not cover the handle-stream size field

**Trap** — assuming an object's declared byte count covers everything after the field that declares it. For R2010+ the prologue is `MS` size **then** `MC` handle-stream size, and the size does **not** include that second field — so the object's real extent is both prologue fields plus the declared bytes. Framing it the obvious way leaves every object exactly one byte short.

**Why it hides** — the data stream is at the *other* end of the object, so all geometry decodes perfectly and lands exactly, while the handle stream truncates mid-handle. It reads as "the handle layout must be wrong for this release", and the natural fix — dropping a trailing handle until the reads fit — is wrong and silently mislabels every reference after it.

**Rule** — in `readObject`, step the probe cursor over **both** prologue fields before computing `end`. A one-byte framing error is detectable: assert the handle stream is exhausted to within 7 bits (byte padding) of `totalBits`, which `readEntity` now does. That check cannot be satisfied by a reader that is one handle short, because the shortest handle is a byte — which is exactly what lets it catch a framing bug the data stream cannot see.

### `dataEnd()` is where the bits stop; `dataStop()` is where the data stops

**Trap** — treating `dataEnd()` as the end of an object's **data** on a pre-R2007 file. R2007 introduced the separate string stream and paid for it with a bit taken *out of* the data: the "strings present" flag occupies the last counted bit. Releases before it have no flag, so the data runs one bit further — and `dataEnd()` is right for both regardless, because the handle stream starts at `dataEnd()+1` either way.

**Why it hides** — assume the flag and **every** pre-R2007 object appears to overrun by exactly one bit, which reads as a field decoded slightly too wide and sends the search to the last field read rather than to the boundary. It compounds badly: the R2004 fixture was hitting this, the xref gate below and a NUL-termination bug all at once, and the three summed to a 23-bit overshoot that looked like one large mistake.

**Rule** — keep the two concepts apart. `dataEnd()` is where the object's bits stop; `dataStop()` is where its *data* stops — `strStart` when strings are present, `dataEnd()+1` pre-R2007, `dataEnd()` otherwise — and decoders assert against `dataStop()`. When several version-gated bugs stack, never reason from the total: find one field whose correct value is knowable independently (see the `412148564080.0` section below, or search the raw bits for a known CMC pattern like `0xC3000007`) and subtract to get an absolute anchor inside the object.

### The table-record xref index is present through R2004 and dropped at R2007

**Trap** — reading the xref index in a **table record** (BLOCK_HEADER, LAYER, LTYPE, …) at the wrong release boundary. The field is present through **R2004** and dropped at **R2007**. This repo asserted R2004 for months, because every fixture it had was R2018 and an R2018-only corpus cannot tell the two rules apart — both predict "absent". An R2004 fixture decides it.

**Why it hides** — the cost of being wrong is wildly asymmetric by record. In LAYER it is a quiet 2-bit slip; in BLOCK_HEADER those two bits land the cursor ahead of the **insert count** — a run of non-zero bytes terminated by a zero — so the slip becomes a **778-bit (~97 byte) overshoot** as the loop reads on until it chances on a zero byte. Nothing about a ~100-byte overrun suggests a 2-bit cause, and it invites a search for a missing large field.

**Rule** — gate on `if !o.Version.AtLeast(R2007)` in both `readLayer` and `readBlockHeader`. Two transferable lessons. **A version rule is only as good as the oldest fixture that exercises it** — when every file in the corpus sits on one side of a boundary, the rule is a guess wearing a citation, so record which fixture proved it. And **a misalignment immediately ahead of a run-length-terminated field never produces a small error**: when a landing assertion reports an overshoot that is roughly byte-sized and much larger than any single field, look for an unbounded byte loop and suspect a tiny misalignment *before* it rather than a big mistake inside it. Cap the loop regardless (`blockMaxInserts`) — it is reading attacker-controlled bytes with no length of its own.

---

## Entity fields

### Entity colour: `0x40` short-circuits `0x80` and costs a handle

**Trap** — reading the `0x80` (true-colour-follows) flag independently of `0x40`, or forgetting that `0x40` also costs a **handle**. `0x40` means the colour is a colour-book entry — a separate object named from the handle stream — and that entry is the entire definition, so no inline `BL` follows even when `0x80` is also set. Honouring `0x80` anyway consumes 10 bits that aren't there and lands the decoder mid-coordinate.

**Why it hides** — the other half lands in a different stream: `0x40` adds a handle, taken **as the colour is read**, i.e. ahead of the owner and every other shared reference. Skip it and the layer slot reads the colour-book object instead — which still resolves to a real object, so only a type check catches it. Only **1 object in 39,096** across the whole fixture set sets the flag, so a decoder can look completely correct and still fail on the next drawing a user uploads.

**Rule** — in `readEntityColor`, return as soon as `flags&0x40` is set, before testing `0x80` or `0x20`, and report the flag to the caller so `readEntityRefs` consumes the leading handle. The bit arithmetic is unambiguous even from the single sample: the fields after the colour cannot fit in what an inline RGB would leave, and the handle stream ends exactly on the object boundary only when the extra handle is read.

### INSERT writes a full `3BD` extrusion, not the `BE` shorthand

**Trap** — assuming the extrusion is always the one-bit `BE` shorthand. Every other entity spends a single bit to say "the usual Z axis" and stops. INSERT writes a full `3BD`, which for the values 0/0/1 costs six bits.

**Why it hides** — it doesn't, much, and that is the useful part: read as `BE`, **every** INSERT in **every** fixture lands exactly five bits short of its declared end (6 − 1 = 5). The constant, uniform offset is the tell — a wrong *value* would vary per object, so a fixed delta across every instance of one type always means a field is the wrong shape rather than the wrong number. There is no obvious reason for the difference and the cost is 5 bits per reference, but the fixtures are unanimous.

**Rule** — use `b.bd3()` for INSERT/MINSERT and `b.be()` everywhere else, and let `TestEntityDecodeConsumesExactlyTheDataStream` arbitrate; it is the only thing that can, since nothing in a DWG states what a coordinate *should* be. When adding a new entity type, read the delta the landing assertion reports before touching anything: a small constant offset names the field, a varying one means the framing is wrong.

### `shadow` is an enumeration whose value 3 costs a handle

**Trap** — reading the `shadow` field as a plain value because its neighbours are flags. It is a **byte-wide enumeration whose value 3 costs a handle**, and nothing about it advertises that: the surrounding fields are two-bit flags, and its other three values are plainly "casts", "receives", "both".

**Why it hides** — it is rare enough to look like it doesn't exist. **16 objects in 139,000** across the whole fixture set set it, all inside block definitions in one drawing. Miss it and the handle stream slips by one handle for those objects only, so their layer/owner references silently point at the wrong objects while every landing assertion in the suite still passes (the data stream is at the other end and is unaffected).

**Rule** — in `readEntityRefs`, consume a handle when `Version.AtLeast(R2007) && h.shadow == 3`, alongside the existing `linetypeFlag` / `material` / `plotStyle` value-3 rules. The general rule for this format: a field's **width** never tells you whether it costs a handle — check each one against the spec's handle list rather than inferring from its neighbours, and treat "only N objects in the corpus set it" as a reason for more care, not less, since the next drawing a user uploads is not in the corpus.

### A pre-R2007 `T` string's length counts its NUL

**Trap** — reading a pre-R2007 `T` string as *n* bytes of text. The length counts a terminating NUL that is not part of the string, so layer `"0"` is written as two bytes, `30 00`.

**Why it hides** — the framing is correct either way (the cursor lands in the same place), so a bit-landing assertion — otherwise this reader's complete proof of correctness — cannot see it at all. It surfaces much later and somewhere else entirely: a layer name that matches nothing, an empty layer filter in the import dialog, geometry assigned to a layer the UI never lists.

**Rule** — `bitReader.text()` trims the trailing NUL. Generally: a landing check proves *framing*, never *interpretation*, so any field whose value the UI shows to a human needs a second assertion against something knowable (layer `"0"` exists in every drawing; `Defpoints` and only `Defpoints` is non-plotting), not just an exact landing.

### A text value is not the characters it draws

**Trap** — reading a DWG/DXF text value as the characters it draws, and trusting the landing assertion to have checked it. Two traps that compound.

**The value is not its text.** `\U+XXXX` names a code point outright, and `%%d` / `%%p` / `%%c` predate Unicode for the symbols a draughtsman's keyboard lacks; both are still written by current releases. `Apartment-1.dwg` stores **every one of its room names** that way — 餐厅 is `\U+9910\U+5385` — so a passthrough reader names the dining room `\U+9910\U+5385` on the map, in the layer list and in every derived area. MTEXT compounds it with a full inline formatting language (`{\fArial|b1|i0;STORE}`) that renders as its own source.

**Why it hides** — the reader's strongest assertion is blind to all of it. From R2007 strings live in a stream of their own, so they cost the data cursor nothing, and an entity whose text was read from entirely the wrong place still lands exactly on `dataStop()`. A decoder can be provably right about its field layout and still emit mojibake.

**Rule** — resolve through `cad.PlainText` / `cad.PlainMText` (`internal/cad/text.go`), never in the reader, because DXF stores identical escapes. **Pass through anything you cannot resolve**: `\M+` needs the code page the text style names, and a wrong guess produces confident nonsense where a stray escape is at least legible and obviously odd. Then assert the payload independently of the framing — rung 16 of the ladder in `ARCHITECTURE.md` §6.12 requires every one of the 3,733 fixture strings to be non-empty valid UTF-8 with no replacement characters, which is the only thing that can catch a misplaced string stream. When a new type with string fields lands, exempt it by **type** in `entity_test.go`'s strings-present check (`o.Type != typeText && o.Type != typeMText`) rather than weakening the check — that check is an independent probe on the last data bit and is load-bearing for every pure-geometry type.

---

## Multi-object structures: chains, attributes, ownership, blocks

### Entities that span several objects decode in two passes

**Trap** — adding an entity type that spans several objects (POLYLINE/VERTEX, INSERT/ATTRIB, and any future MESH) as if it decoded from its own bytes alone. The old POLYLINE keeps **no points**: it names separate VERTEX objects through its handle stream, and a SEQEND closes the run.

**Why it hides** — a reader that only handles single-object entities silently opens such a drawing as **empty**. One fixture is 94,183 objects of which 91,521 are chain parts, and it produced `ErrNoGeometry` until the chain shipped. The subtler half is that the vertex **count** is read from the *data* stream while the handles it counts live in the *handle* stream, so a miscount consumes a different number of handles and still lands legally: every per-object assertion passes and the geometry is quietly wrong.

**Rule** — decode across two passes, the way `document.go` already does for layer names: `readEntity` returns a `part` (an entity **or** a loose fragment, plus `entityRefs.Children`), and the parent is stitched afterwards. Do **not** make the fragment a `cad.Entity` — emitting vertices as entities puts 90,000 stray points into a drawing of lockers. Prove the wiring with cross-drawing arithmetic rather than per-object checks: `TestPolylineChainsClaimEveryVertex` asserts every VERTEX is claimed by **exactly one** polyline, which a count read one-too-high fails (it steals the neighbour's first vertex, so one is contested and one is orphaned) and which nothing else in the suite can catch. A named vertex that is missing must be a hard error, not a dropped point — a polyline silently missing a corner is a shape the drawing does not contain.

### ATTRIB/ATTDEF: settle the layout on interpretation, not on framing

**Trap** — implementing ATTRIB/ATTDEF from the specification's field list rather than from the bits. The ODA/LibreDWG description puts a `class_version RC` at the **front** of every R2010+ attribute. Both R2018 fixtures here contradict it: there is no such byte, and reading one consumes TEXT's own `data_flags` instead (values 181/198/214/246 — recognisable as `textAlignAtInsert|textNoOblique|textLeftAligned|textBaseline` combinations). ATTDEF does carry one extra byte at R2010+, but it sits at the **tail**, before the prompt.

**Why it hides** — landing cannot arbitrate where the byte goes: three placements share the same width, and from R2007 a `TV` costs the data cursor **zero** bits, so the position of a string field is unobservable.

**Rule** — settle it on **interpretation**, not framing. Two independent arguments agreed here: the documented-unused `field_length` stays at one value (`0x0600`) across both types under the trailing placement and splits into 774-vs-6 under the leading one; and the trailing placement yields `flags = 6` (constant) for 918 records, which a semantic cross-check confirms — a *constant* attribute never receives an ATTRIB, and indeed the nine constant tags in `fast-food-Restaurant.dwg` have zero ATTRIBs anywhere in the file while both variable tags have them.

That is the emit rule too: ATTRIB draws unless invisible; ATTDEF draws only when constant, because otherwise it is the placeholder inside the definition and emitting it stamps "ROOMNO" at every insertion point (920 definitions against 9 answers in that fixture).

### Drop attributes whose value is the empty string

**Trap** — emitting an attribute (or any text entity) whose value is the empty string. A blank ATTRIB is completely ordinary: **202** of one hotel fixture's `ROOM_NAME` attributes are placeholders nobody filled in.

**Why it hides** — emitted, they become invisible text entities sitting at coordinates that mean nothing. They contribute to the drawing's extent, so they enlarge the placement box and shrink the building inside the pixel budget, while drawing not one pixel to show for it. Worse, from outside the decoder a run of empty strings reads exactly like a **misplaced string stream**, so it masks the one bug the corpus-wide "every string is readable" assertion exists to catch.

**Rule** — drop them at the point of decode (`entity.go`'s attribute path returns `nil` for `t.Value == ""`, alongside the invisible-flag and non-constant-ATTDEF cases). That is what lets the reader's own check stay at *every* string in the corpus being non-empty valid UTF-8 rather than degrading to *most*. General rule: an entity that draws nothing should not reach `cad.Paths`, because everything downstream — extent, scale, pixel budget — is computed over what it was handed.

### Resolve block ownership transitively

**Trap** — filing an entity into a block by looking its stated owner up in the block table and falling through to model space when the lookup misses. Some entities are owned by another **entity**, not by a block: an ATTRIB belongs to the INSERT it labels, the way a VERTEX belongs to its polyline. Its owner handle therefore never appears in the block table, so the "not found → model space" branch swallows it, and a tag attached to an insert *inside a block definition* is drawn once at the definition's own coordinates instead of once per insertion — a label stranded at the origin while the thing it names sits across the plan.

**Why it hides** — every attribute in all five fixtures hangs off an insert that is itself directly in model space, so the walk is one hop and the wrong answer and the right one coincide. That is the reason to write the rule, not the reason to skip it: the case it guards is a drawing we do not have, and it fails silently.

**Rule** — resolve ownership **transitively**: `document.go` walks `entMode`/`owner` from the entity through each parent until the handle names a block, capped at `maxOwnerHops = 32` because the handles come from the file and a drawing can name a cycle for free. On the test side, skip such types by **type** (`o.Type == typeAttrib`), never by "its owner wasn't in the map" — `isSpaceOwned` returns `true` on absence deliberately, so an absence-based skip cannot tell a subentity from the missing-listing bug the test exists to catch. Replace the coverage you lose with a cross-stream assertion instead of dropping it: `TestAttributesHangOffInserts` checks both directions, because the insert declares its attribute count in its **data** stream and spends the handles in its **handle** stream, so a miscount consumes a different number of handles and still lands legally. Forward (declared count == number naming it) and backward (every owner is an INSERT) have to agree for either to mean anything.

### Block definitions are identified by handle, not by name

**Trap** — registering block definitions by the name the file gives them. A DWG does **not** name its generated definitions individually — it stores them under a bare prefix, so one mezzanine fixture holds **875 BLOCK_HEADERs all called `*D`**, one per dimension (the number a CAD application shows beside them is its own invention). Registered as they stand, 874 are silently redefined as a copy of whichever arrived last.

**Why it hides** — it didn't hide so much as shimmer. Because the source was a **map**, which definition won differed on every read, so *the same drawing converted to a different size each time it was opened*, with no error and nothing in the output naming the cause. Non-determinism is the tell: a size that changes between two reads of identical bytes is always a map iteration order feeding something order-sensitive.

**Rule** — walk a recorded order (`blockOrder`), and suffix collisions through `uniqueBlockName`, which carries its counter across calls in a `nextSuffix` map (a per-collision rescan from 1 is quadratic on a file that costs an attacker nothing to produce). Then have the entity pass resolve its block **by handle** and copy the name afterwards, so a renamed definition still receives its own inserts. Same rule for any future by-name registration out of this format: names in a DWG are display strings, handles are the identity.

---

## The `AcDb:Header` walk

### Anchor on `412148564080.0`, not on the field where the walk errors

**Trap** — debugging a wrong `AcDb:Header` walk from the field where it *errors* rather than from the first field whose correct value is knowable. The header is a few hundred variables with no names, no tags and no lengths, so a three-bit slip at the very front stays silent for a thousand bits and then surfaces as `reserved bit-long pattern` in the middle of the timestamps. Every instinct then points at the timestamps, and they are fine.

**Why it hides** — this is exactly what R2013's **`REQUIREDVERSIONS`** did — a `BLL` ahead of everything else, **3 bits** when its length byte-count is zero. R2018 failed and all four R2007 fixtures passed, which reads as "the R2010+ dimension block is wrong" because that is the other thing that differs between them.

**Rule** — anchor on the fourth field in: the first of the four unnamed leading `BD`s is **`412148564080.0`** in every file ever examined. It is the one value in the section whose correctness can be judged without having read anything before it, so scan bit offsets for it and the true start of the data stream falls out directly (32 for R2007, **35** for R2013+). Generally, in a positional format find a self-verifying constant near the head and check *that* before tracing forward from an error site — the error site is downstream of the cause by an unbounded distance.

### The header body's leading `RL` counts itself

**Trap** — reading the `AcDb:Header` body's leading `RL` as a count of the bits that *follow* it. It counts **itself**, so the strings-present flag sits at bit `bits-1`, not `bits`.

**Why it hides** — off by one in the exclusive direction, the flag reads 0 on every fixture, the reader concludes the section has no strings, and 22 KB of legible text (linetype names, the producer URL, both GUIDs) is discarded without a word. Nothing errors: a header with no strings is completely legal, and the data stream then simply runs to a different end and fails its landing assertion somewhere unrelated.

**Rule** — locate the string stream from `bits-1` and reuse the object path's backwards layout verbatim (`headerStrings` mirrors `object.locateStrings`). Verify by reading the strings, not by the flag: `FINGERPRINTGUID` and `VERSIONGUID` are brace-wrapped GUIDs and are unmistakable when the stream is found correctly. Same family as the `nameLen` section above — resolve every length field in this format against a fixture before building on it.

### The header's handle stream is not exhausted, and must not be asserted so

**Trap** — asserting the `AcDb:Header` handle stream is exhausted the way an object's is. It isn't: the body runs ~10 bytes past its last handle in every fixture, with contents that differ per file and match nothing else in it — page filler, most likely.

**Why it hides** — enforcing exhaustion makes a fully correct walk fail, and the natural "fix" (inventing trailing handles until the bits are consumed) silently mislabels the real references, because a handle that resolves to *some* object looks fine.

**Rule** — assert what the handles **are**, not how many bits they cost: the nine table controls have fixed types, paper space is a BLOCK_HEADER, the named-object root is a DICTIONARY, and model space must be the same handle the block table independently calls `*Model_Space` (`TestHeaderNamesTheObjectsItClaims`). Keep a loose byte-scale bound on the leftover so a genuinely truncated stream still errors.

---

## Curves

### Verify a curve against a case whose answer is knowable without the code

**Trap** — verifying a new **curve** decoder with the landing assertion alone, or tessellating one without asking what bounds its error. Landing proves *framing*, never *interpretation* — the same blindness the text section above describes, arriving by a different route: a spline's field layout can be exactly right while the evaluator that turns it into points is wrong, and every fixture still passes. And a curve with no radius has nothing to invert the sagitta against, so the arc/ellipse argument does not transfer: reusing `segments` on a NURBS span means inventing a radius, and joining the control net as if it were the curve cuts every corner the spline was drawn to round.

**Rule** — find the case whose answer is knowable without the code under test. For NURBS that is the rational quadratic over (1,0), (1,1), (0,1) with weights 1, √2⁄2, 1 — *exactly* the unit quarter circle, so every emitted point must sit at radius 1, and an evaluator that ignores weights, misindexes knots or walks the hull fails it immediately (`TestRationalSplineDrawsTheCircleItDefines`).

For the tessellation, bound the error by the convex hull: a span lies inside the hull of the control points influencing it, so the furthest of those from the span's chord bounds the deviation, and it falls with the **square** of the subdivision count — hence a square root, not a linear count.

Two further rules for any new curve. Validate the structural preconditions the evaluator divides by (a non-decreasing knot vector — otherwise infinities reach the client as coordinates) and fall back to *something drawable* rather than dropping the entity. And **do not emit the closing point when the path is `Closed`** — it duplicates the first, which is invisible in an outline and fatal to a triangulator (`TestClosedCurvesDoNotRepeatTheFirstPoint`).

---

## Verification discipline

### Decode a type when a fixture contains it — but count before you defer

**Temptation** — writing an entity decoder for a type **no fixture contains**, to "finish the spec".

**Why it backfires** — two things make it worse than the gap it closes. `TestEntityDecodeConsumesExactlyTheDataStream` is the *only* complete proof a field layout is right (nothing in a DWG states what a coordinate should be), so a decoder with no object to land on is unverifiable by construction and reads as done. And `readEntity`'s errors are **fatal to the whole document** (`document.go` returns them), so today an unhandled type is silently skipped and the drawing still opens, whereas a wrong decoder makes the first user file containing one fail outright. "Completing" the spec speculatively trades a working import for a broken one. TRACE/3DFACE sit here deliberately: zero occurrences across all five fixtures.

**Rule** — decode a type when a fixture contains it, and record which fixture proved it — the same rule as the version-boundary section above (*a version rule is only as good as the oldest fixture that exercises it*). **But count before you defer.** SOLID was parked here on the same reasoning and the reasoning was never checked: the corpus holds 15 of them, and once looked for they landed exactly at both R2004 and R2018 on the first attempt. "No fixture" is a measurement, not an assumption — run the census. If a user reports a drawing that opens empty or thin, get the file first; it is worth more than the specification page. Until then the skip is the correct behaviour, not a TODO.

### Never let a skip path bypass the landing assertion

**Trap** — giving a decoder a skip path that returns before `readEntity`'s landing assertion. The assertion is the reader's **entire** proof of correctness — exact landing on `dataStop()` is all there is — so an early return that bypasses it does not merely lose coverage for that object: it makes the arbiter report success for a layout it never checked.

**Why it hides** — the first ATTRIB implementation here "passed" the full suite while **929 objects took the escape**, because a misplaced version byte sent every R2018 attribute down a `version > 1` branch that returned early. The entity count was unchanged and nothing in the output said so.

**Rule** — if a type genuinely needs graceful degradation (an annotation, never geometry — a plan missing one label is survivable, a plan silently missing a wall is not), make the escape **visible**: return a flag on the `part` (`Skipped`) and have `entity_test.go` assert it is never set across the corpus. That keeps the escape available for the drawing you don't have while proving it is unused on the ones you do. Never let a decoder return a bare zero value on a path the test cannot distinguish from a decode.

---

See `docs/cad-import.md` for what happens to a decoded `cad.Document` — outlier trimming, unit resolution, tessellation, rasterization and the HTTP surface — and `docs/backend.md` for the surrounding Go conventions.
