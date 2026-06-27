# Star Fluid Sim

A WebGL fluid simulation featuring colored "star" emitters whose dye blends in a subtractive, paint-like way — red + yellow → orange, blue + yellow → green, red + blue → purple, complex mixes → muddy brown.

Built on top of [Pavel Dobryakov's WebGL Fluid Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation) (MIT license), with significant custom additions:

- **Star emitter system** — place, color, and configure multiple dye-emitting stars via a dedicated panel
- **Subtractive/paint color mixing** — uses [Mixbox](https://github.com/scrtwpns/mixbox) pigment model with RYB color remapping and SC (sinusoidal) hue encoding to prevent complement cancellation during fluid advection
- **Radial dye emission** — 12-ray staggered emission with frame-angle rotation to defeat hourglass cancellation from the pressure solver
- **dat.GUI controls** — sim resolution, pressure, curl, bloom, sunrays, and more

## Running locally

Open Chrome with file access enabled:

```
chrome.exe --allow-file-access-from-files path\to\index.html
```

Or use the included `LAUNCH.bat` on Windows.

For deployment, any static host works (GitHub Pages, Netlify, etc.) — no build step required.

## License

Based on [WebGL Fluid Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation) by Pavel Dobryakov, MIT License.

All modifications © 2025 Trey Hakanson, MIT License.

See [LICENSE](LICENSE) for full terms.
