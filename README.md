# Levora

Dynamic range compression for browser audio, remembered per site. Dialogue stays
audible, explosions stop being an event. One slider.

Firefox first (MV3, 128+); a Chrome build is produced by the same source.

## Not compatible with Boostr

`createMediaElementSource` is a one-way door and can be called on a media element
exactly once. Levora and Boostr both want that call, so whichever gets there
first owns the element and the other silently does nothing. Run one or the other,
not both.

## How it works

```
element ─ levora (AudioWorklet) ─ destination

inside the worklet:
  K-weighted loudness ─ compressor ─ leveller ─ lookahead limiter
       (measure)            (ms)     (tens of s)     (peaks)
```

One path, always. Bypass is a flag inside the worklet, not a parallel dry gain
beside it — see below.

Everything that shapes the signal runs on the audio thread, in
`src/worklet/levora-processor.js`. The content scripts only do routing.

### Measuring loudness the way ears do

Loudness is measured with K-weighting, per ITU-R BS.1770 — the same measure
broadcast uses, and the reason the popup can honestly print a LUFS number.

A flat RMS counts a 40 Hz rumble the same as a line of dialogue. That is not an
academic complaint: the measurement drives every decision here, so under a flat
meter a bass-heavy passage reads louder than it sounds and gets ducked for it,
while speech reads quieter than it sounds and is lifted less than it should be.
Precisely backwards for what this is for.

The measured curve, relative to 1 kHz:

| 20 Hz | 40 Hz | 100 Hz | 1 kHz | 3 kHz | 6 kHz+ |
| --- | --- | --- | --- | --- | --- |
| −14.0 | −6.3 | −1.8 | 0 | +3.1 | +3.3 |

Nine and a half dB between a rumble and dialogue — that is the size of the error
the flat meter was making.

Two details worth keeping straight, both of which caught a wrong test
expectation first:

- The RLB high-pass has Q ≈ 0.5, and a second-order high-pass is down by exactly
  Q at its corner. So the bottom falls away by 6 dB at 38 Hz, not the 3 dB a
  "corner frequency" suggests.
- The coefficients are derived from the analog prototype rather than hard-coding
  the published 48 kHz set, because a browser hands out 44.1 kHz just as readily.
  A test pins the derivation against the published values.

### The programme reference, gated

Both user controls are stated against the programme's loudness, so a reference
that wanders makes both of them wander. A plain average is dragged down by quiet
stretches. BS.1770 answers this with two gates — an absolute one at −70 LUFS and
a relative one 10 LU below the ungated mean — which keeps quiet material out of
the average that defines the programme.

The gate is applied to the momentary (0.4 s) value rather than the raw block:
gating on 2.7 ms blocks would throw away the gaps between words and read speech
as louder than it is.

### Two modes over one mechanism

**Basic** is two sliders: how much compression, and how much gain after it.
**Advanced** is the three numbers the engine actually takes, plus the same gain.

Basic does not simplify by hiding a feature — it drives the same three values
off one curve. Presets are points on that curve, which is why they light up in
both panels.

**Each panel owns its own controls, and neither writes to the other's.** Only the
active panel's values reach the engine, and switching is reversible: the knobs
are where you left them when you come back, and so is the slider. Clicking a
preset writes only the panel it was clicked in.

That costs a change in sound at the switch, and it is worth it. An earlier
version carried the basic slider's meaning into the knobs so the level would not
move — and silently overwrote hand-set knob values when someone glanced at basic
mode. A level change is undone by switching back; a lost setting is not.

Two things are shared on purpose, because they are one control rather than two:
**Output**, which is shown in both panels, and **Response**, which is a
preference about character and stays in force whichever panel is open.

| Control | Mode | Means |
| --- | --- | --- |
| **Compression** | basic | Further right is stronger. Drives all three below |
| **Response** | advanced | Static or adaptive — see below |
| **Hold above** | advanced | LU above the programme's own loudness. Anything louder is held down to this line |
| **Lift below** | advanced | LU below it. Levelling tapers to nothing here — this is how deep it reaches |
| **Ratio** | advanced | How hard the compression is above the threshold |
| **Output gain** | both | Make-up gain, in dB |

At full strength a 16 dB gap between scenes comes out at 2 dB; at zero it is
left alone.

### Static or adaptive

How the gain is arrived at, and the one decision that changes the character
rather than the amount.

**Static** is memoryless: gain is a function of the current level and nothing
else, through the two-sided transfer curve in `transferDb`. The same input level
always produces the same output level, so a quiet line after an explosion sounds
as it would in silence.

**Adaptive** is a slow loop chasing the programme level. It levels further, and
it pays for it: because the gain depends on what came before, the end of a loud
passage lets quiet material drift up toward the level the loud material had, and
its return pushes it back down. Smooth, but a swing, and an audible one.

Measured on a programme alternating between −30 and −14 dBFS in 20 s scenes.
"Drift" is how far the output of a constant quiet passage moves over eight
seconds after a loud one ends — the swing, in a number:

| Compression | Scene gap, static | Scene gap, adaptive | Drift, static | Drift, adaptive |
| --- | --- | --- | --- | --- |
| 45% | 11.2 dB | 10.7 dB | 0.5 dB | 4.7 dB |
| 65% | 7.5 dB | 7.0 dB | 1.7 dB | 6.6 dB |
| 100% | 3.9 dB | 1.9 dB | 3.8 dB | 9.4 dB |

Static is the default: the swing is what people notice, and the levelling it
gives up only becomes significant at the top of the range. Both directions of
the trade-off are pinned by tests so neither can be quietly lost.

The curve's corners are hard rather than soft-kneed. A knee centred on the
threshold reaches below it, into the region the curve holds at unity, and the two
disagree — the first version went *down* as the input went up just past the
threshold. Every boundary is continuous now and the whole curve is provably
monotonic, which is worth more than a rounded corner. The program-dependent
ballistics smooth the gain anyway.

### LU, not dB

The two level controls are in **LU**, and the distinction matters. LU is
loudness *relative* to a reference; **LUFS** is the absolute scale. "+8 LU"
means eight above this programme's own level, which for ordinary material lands
near −12 LUFS — nowhere near full scale.

Labelling it "dB" invites the reasonable question of why a threshold may sit
above zero, and the answer is that it is not that kind of zero. Film sits 15–20
dB below its own peaks, so a threshold above the programme level is still well
under the ceiling. The popup prints the resolved LUFS under each of these knobs
so the relation is visible rather than asserted.

### The one control that changes loudness

`Output` is make-up gain and it says so. Everything else must not touch the
level: a dynamics control that also moves loudness gets tuned by loudness,
because louder wins in the first few seconds.

An earlier version of this file stated that rule as "no control is an output
level", which was too blunt — make-up is a real part of a compressor, and heavy
compression genuinely leaves the programme sitting quietly. The rule is that
make-up is *separate and labelled*, not that it is absent. A test pins exactly
one such control.

It is applied **before** the limiter, so pushing it up drives limiting instead
of clipping: at +12 dB into a −6 dBFS peak the limiter takes 7.5 dB back and the
output lands on the ceiling exactly.

Together the first two describe a window around the programme's level:

```
          louder
            │   held down to the threshold
  threshold ┝━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            │   left alone
  programme ┝ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
            │   lifted toward the programme,
      floor ┝━━━━━━━━━━ tapering to nothing
            │   left alone
          quieter
```

The threshold is one line across both timescales — the compressor's threshold
and the leveller's ceiling. It has to be: a threshold that governed
milliseconds but not tens of seconds would promise "only touch what is 12 dB
above average" while the leveller quietly pulled every loud scene down to
average anyway.

### Why the dB are relative

Both dB controls are stated against the programme's own loudness rather than
absolutely. An absolute threshold is the right control in a DAW, where the
material is known and fixed. A browser sees YouTube near −14 LUFS, a disc rip
near −27 and a podcast near −16, and one absolute number does three different
things to them. Relative, one setting behaves the same everywhere — and since
the worklet measures the programme anyway, the popup shows the resolved dBFS
next to each knob, so the numbers stay concrete.

`test/core.test.js` asserts this directly: the same setting produces the same
gain reduction on two programmes 12 dB apart.

Note that **no control is an output level.** That is deliberate and load-bearing:
a control that changes loudness gets tuned by loudness, because louder always
sounds better for the first few seconds. Volume is a different tool's job.

### Two timescales

**Milliseconds** are the compressor's: syllables, transients, a door slam. A
soft-knee curve over an RMS detector, with a program-dependent release — a
second, lazier reduction envelope runs alongside the first and the more
conservative of the two wins, so a stab recovers quickly while a sustained loud
passage does not pump back up between syllables. That is the difference between
"dense" and "even", and it is the thing a bare `DynamicsCompressorNode` cannot
be told to do.

**Tens of seconds** are the leveller's, and this is what "the whole film at one
level" actually means. A quiet dialogue scene and the battle after it are half a
minute apart; no attack or release setting reaches that far.

Aiming the leveller at the *moment* rather than the programme is a trap worth
naming, because an early version fell into it: the output is then made to copy
the very envelope it was asked to flatten. Gain reduction looks healthy, the
meter moves, and nothing is levelled.

### Lookahead limiting

Without lookahead a limiter is always late: the transient has passed by the time
the detector has seen it, so the first milliseconds of a door slam go through at
full level and the only way to catch them is an attack fast enough to distort.

The worklet delays the audio by four blocks — 10.7 ms — and decides everything
from the block just arrived, applying it to the block leaving the line. That
gives the *whole chain* lookahead rather than only the limiter: the compressor's
attack has finished moving before the transient that caused it is heard.

Longer is not monotonically better, which is the trap. The window has to cover
the attack, or the lookahead bought nothing. Push it much past that and the gain
drops audibly *ahead* of the event — heard as a breath or a suck before every
hit. Ten milliseconds is the usual ceiling for a limiter meant to be
transparent, and it is far under the ~45 ms where audio lagging video starts to
show. A test pins the window between those two bounds.

The gain applied to the block leaving the delay line accounts for the minimum
required across every block still inside it, so nothing in flight can exceed the
ceiling and the ramp can be gentle. Recovery is a one-pole release, because
coming back up is the part that is allowed to be gradual.

This replaced a native `DynamicsCompressorNode`, which cannot be told to look
ahead. The ceiling is sample-peak rather than true-peak: inter-sample peaks can
sit slightly above it, which is a clipping concern on the way out of a DAC
rather than something audible, and the −1.5 dBFS ceiling leaves room for it.

### Why a worklet

The first implementation ran the same idea from a `setInterval` over
`AnalyserNode` snapshots and a `GainNode`. Three things were wrong with that, and
all three are structural rather than bad luck:

- It saw ~46 ms out of every 200 ms, and stopped entirely in a background tab.
  The worklet sees every block.
- It measured its own output and stepped toward a target — a feedback loop, so
  it needed step fractions, converged rather than arrived, and could ring. On
  the audio thread the output level is *known*: `out = in + reduction + level`,
  so the required gain is solved directly.
- Gain was scheduled with `setTargetAtTime` on two nodes arranged to cancel.
  They cancel at their endpoints and not while they ramp — `setTargetAtTime` is
  exponential in linear gain, so a rising and a falling ramp multiply to +27 dB
  in the middle. That was a blast on every touch of the slider.
  `test/gain-ramp.test.js` keeps it from coming back.

Gain is now one number, interpolated per sample inside one `process()` call.

### One path, and why

The obvious way to guarantee transparency when off is a dry gain in parallel
with the processed path, crossfaded. It is wrong here, and it was shipped wrong
once: the processed side is delayed by the lookahead, so while the two
crossfade — and `setTargetAtTime` is exponential, so "while" is a good fraction
of a second — the same audio reaches the output twice, about 10 ms apart. That
is a slapback. It is heard as the sound doubling and swelling, and lengthening
the lookahead from 5 to 10 ms made it worse rather than better.

So the worklet is always in the path and bypass is one of its parameters: off
means it passes the delayed input through at unity, ramped per sample so the
switch is click-free. The core keeps measuring while bypassed, so switching back
on does not restart from nothing. The cost is a constant 10.7 ms of latency
while an element is attached, which is not a coloration and cannot be heard.

### Rules the code will not break

1. **`createMediaElementSource` is irreversible.** One call per element, tracked
   in a `WeakMap`.
2. **Never route into a suspended `AudioContext`, or before the worklet has
   loaded.** Settings persist per origin, so "on" arrives at page load, long
   before any user gesture, and `addModule` is asynchronous. Routing waits for a
   real `play` event, a running context, *and* a loaded processor. Neither wait
   marks the element failed — the sweep retries. An element taken through the
   one-way door into a chain we cannot finish is an element we broke.
3. **Gain is measured, never predicted, and there is only one of it.** It starts
   at unity and settles within about 0.3 s, downward. Across every preset the
   output never exceeds the source while settling, which is asserted directly.
4. **Unavailability is visible before you turn it on.** DRM is caught by the
   `encrypted` event and CORS-tainted media by an origin check, both before
   routing. The popup says why instead of showing a dead slider.

## Layout

| Path | Role |
| --- | --- |
| `src/worklet/levora-processor.js` | The signal chain. `LevoraCore` is pure and tested |
| `src/lib/controls.js` | Both modes: ranges, the strength curve, presets, travel. Pure and tested |
| `tools/render-icons.mjs` | The icon, as geometry. Rasterises to PNG with no dependencies |
| `src/content/engine.js` | Isolated world: finding media, routing it, passing parameters |
| `src/content/overlay.js` | The fullscreen control, in a shadow root |
| `src/content/main-world.js` | Page world: catches sites with no `<video>` at all |
| `src/background.js` | Per-origin settings, badge, message routing |
| `src/popup/` | The control panel |

`lib/controls.js` writes to `globalThis` instead of exporting, because it has to
load three ways: as a content script (no modules there), as a popup import, and
as a test import. The worklet is a real module and exports normally — its
`registerProcessor` call and base class are guarded so `node --test` can import
`LevoraCore` on its own.

### Reaching the audio

Three mechanisms, because no single one covers a browser page:

| Where the audio is | How it is reached |
| --- | --- |
| `<video>` / `<audio>` in the light DOM | `createMediaElementSource` |
| Inside a cross-origin iframe | Same, from a content script in that frame |
| Inside an open shadow root | Same, but the root has to be found and watched separately |
| Web Audio with no media element | The page-world hook |

Shadow roots need their own handling because a shadow boundary stops all three
of the things the engine relies on: `querySelectorAll` does not descend into
one, neither does `MutationObserver` with `subtree`, and media events are not
composed, so `play` inside a shadow root never reaches a listener on the
document — capture phase included. A player built out of web components is
therefore not "blocked", it is invisible, which is a worse failure because
nothing reports it.

What stays out of reach, and why tab capture would not help:

- **DRM (EME).** Excluded from tab capture output as well, so a whole-tab
  approach would return silence here too.
- **Cross-origin media without CORS.** Tab capture *would* fix this one. It is
  the only category where it would.
- **Closed shadow roots.** There is no way to obtain one from outside, and
  prying it open by patching `attachShadow` would change how the page behaves
  for everyone, not just for us.

Whole-tab capture is not an option on the target browser in any case: Firefox
has never implemented `tabCapture`, and its `getDisplayMedia` returns video
without an audio track.

### Two worlds

Games, Howler.js and hand-rolled Web Audio players never create a media element
— they push buffers straight at `AudioContext.destination`. That graph lives in
the page's own JS world, out of reach of an isolated content script, so
`main-world.js` patches `AudioNode.prototype.connect` and re-routes those
connections through a chain of its own — running the same worklet processor, so
both paths sound identical and there is one DSP implementation rather than two
that drift. A plain gain stands in until `addModule` resolves, because the
patched `connect()` is synchronous and a page whose audio waits on a network
fetch is a page we broke.

The worlds cannot share objects, so they talk through attributes on `<html>`.
Only data crosses: the computed parameters, and the processor's URL, which only
the isolated side can produce.

### Scope: per site

Not per tab, and not global. A setting belongs to an origin — enable it on
`https://www.youtube.com` and every YouTube tab has it, now and after a restart;
`twitch.tv` is untouched until you enable it there too.

Sub-frames inherit the top-level page's setting rather than their own origin's,
so a site's embedded players are covered by enabling the site.

A change is pushed to every open tab on that origin, not only the one the popup
was open in. Applying it to a single tab made the storage and the behaviour
disagree: a second tab on the same site kept the old setting until it happened
to reload. Per-site has to mean per-site everywhere at once, or it is a per-tab
setting that merely remembers.

### Two lifetimes

`storage.local`, keyed by origin, holds the setting — a taste, so it outlives the
browser. `storage.session`, keyed by tab, caches capability reports so the popup
can explain a disabled control. Nothing lives in memory; the service worker is
evicted after ~30 s idle.

## Development

```bash
npm install
npm test
npm run check
npm run icons
npm run build
```

`npm run icons` regenerates `src/icons/*.png` and `assets/icon.svg` from the
geometry in `tools/render-icons.mjs`. The mark is a smooth wave, and that is all
it is: 16 px is the size that decides, and it holds one idea. Three attempts at
saying more are recorded in the file — wedges converging on a bar (reads as the
"collapse" glyph), jagged settling to even (an even waveform at constant
amplitude is a rectangle), and a wave clipped against a ceiling (clipped crests
joined by straight diagonals read as a letter). Horizontal and continuous on
purpose: Boostr's mark is vertical bars, the two extensions cannot run together,
and they must not be confusable in a toolbar.

`node build.js` writes `dist/chrome` and `dist/firefox`; `--zip` packs them. Load
`dist/firefox` through `about:debugging` → *This Firefox* → *Load Temporary
Add-on*, pointing at `manifest.json`.

## Submitting to AMO

`data_collection_permissions` is deliberately not in the manifest. The key only
exists from Firefox 140, and `strict_min_version` is 128 because that is when
`world: "MAIN"` landed in `content_scripts` — declaring it anyway earns two
review warnings for a key that does nothing on the version we target. Declare
"no data collected" in the Developer Hub submission form instead.

Nothing assigns to `innerHTML`. The overlay's markup was a static template with
nothing interpolated into it, so it was safe — but a reviewer cannot tell that
from the outside and neither can a linter, which flags every assignment on
sight. The tree is built node by node.

## Known gaps

- The ranges and presets in `src/lib/controls.js` are plausible starting points,
  not tuned by ear. They are meant to be moved.
- A graph whose media element leaves the document is disconnected but not
  released: `createMediaElementSource` cannot be called twice, so the source node
  has to be kept in case the element comes back. Memory is bounded by the number
  of distinct elements ever routed on a page, which is one on most players.
- The worklet stays in the signal path while switched off, so it costs a little
  CPU and a constant 10.7 ms of latency for as long as an element is attached.
  That is the price of bypass being a flag rather than a second path.
- The two mode panels are stacked in one grid cell so switching cannot change
  the popup's height. It used to, and the window flashed as it resized; the
  basic panel is centred and roomy to fill the space that reserves.
- Knee, attack and release are fixed constants rather than controls.
- The leveller is validated against a synthetic two-scene programme, not against
  real material.
- The worklet works in stereo, so a surround source is downmixed to two
  channels by the browser before processing.
- The fullscreen overlay sits at a fixed 84 px from the bottom, which clears most
  players' controls but is not measured.
