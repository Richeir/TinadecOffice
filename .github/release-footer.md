<details>
<summary><b>Installation</b> &nbsp;·&nbsp; Windows x64 / Linux x64 / macOS arm64</summary>

<br>

| Platform | Asset |
| --- | --- |
| Windows x64 | `TinadecOffice-__VERSION__-win-x64-setup.exe` (installer) or `TinadecOffice-__VERSION__-win-x64-portable.exe` |
| Linux x64 | `TinadecOffice-__VERSION__-linux-x64.deb` (x86_64, Ubuntu 24.04 tested) |
| macOS arm64 | `TinadecOffice-__VERSION__-osx-arm64.dmg` (Apple Silicon) |

Each platform also ships `tinadec-office-tools`, `tinadec-office-core` and `tinadec-office-gateway` runtime modules plus a `tinadec-office-agentpack` archive. `catalog.json` describes all five products and their per-platform artifacts for Tinadec Manager.

`SHA256SUMS` covers every published asset. Its keys follow the release layout (`./<installer>`, `./office-channel/<module>`), so verify it from a directory that mirrors that structure rather than from a flattened download.

</details>

<details>
<summary><b>Known boundaries</b> &nbsp;·&nbsp; unsigned builds, no auto-update, per-platform sandboxing</summary>

<br>

- The Windows installer is not code-signed and the macOS app is ad-hoc signed without notarization: SmartScreen and Gatekeeper will warn on first launch.
- Linux ships an x86_64 `.deb` only (no arm64, no AppImage).
- There is no in-app auto-update. `latest.yml` is published for tooling; the app does not consume it.
- Sub-agent sandboxing is per platform: Landlock on Linux, seatbelt on macOS, a restricted local account on Windows.

</details>
