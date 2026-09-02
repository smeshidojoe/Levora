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
element ──┬─ dry ─────────────────────────────┬─ destination
          └─ levora (AudioWorklet) ─ limiter ─ wet ┘
```

Everything that shapes the signal runs on the audio thread, in
`src/worklet/levora-processor.js`. The content scripts only do routing.

### Three controls

| Control | Means |
| --- | --- |
| **Hold above** | dB above the programme's own loudness. Anything louder is held down to this line |
| **Lift below** | dB below it. Levelling tapers to nothing here — this is how deep it reaches |
| **Ratio** | how hard the compression is above the threshold |

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
| `src/lib/controls.js` | The three controls: ranges, presets, knob travel. Pure and tested |
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
npm run build
```

`node build.js` writes `dist/chrome` and `dist/firefox`; `--zip` packs them. Load
`dist/firefox` through `about:debugging` → *This Firefox* → *Load Temporary
Add-on*, pointing at `manifest.json`.

## Known gaps

- Icons are placeholders carried over from Boostr and need replacing.
- The ranges and presets in `src/lib/controls.js` are plausible starting points,
  not tuned by ear. They are meant to be moved.
- Knee, attack and release are fixed constants rather than controls.
- The leveller is validated against a synthetic two-scene programme, not against
  real material.
- The worklet works in stereo, so a surround source is downmixed to two
  channels by the browser before processing.
- The fullscreen overlay sits at a fixed 84 px from the bottom, which clears most
  players' controls but is not measured.
