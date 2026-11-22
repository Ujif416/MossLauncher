# Architecture

Electron main-process modules in src/main use CommonJS. Renderer views in src/renderer use ES modules and the context-isolated preload API in src/preload.

- minecraft.js resolves inherited versions, installs shared libraries/assets, runs loaders and launches isolated game instances.
- A .moss-installed marker records completed versions; dependency-only base versions remain hidden.
- ipc-handlers.js sends one installation lifecycle to the renderer, suppressing intermediate dependency completion.
- auth.js implements Microsoft device-code authorization and the Xbox/Minecraft token chain; secrets are not sent to renderer account lists.
- app-state.js owns selected version and updates its mods. Home controls update only when their inputs change, independently of download counters.
- mods.js view displays the destination version and mod folder. game-instance.js synchronizes its managed mods into that version's instance on launch.
- protocol.js serves renderer and complete assets through app://launcher with path boundaries.
- release builds use electron-builder.release.cjs and build/installer-safety.nsh to reject project directories before installation or removal.

Checks: tools/smoke.cjs, functional-check.cjs, regression-check.cjs, neoforge-regression.cjs and loader-installer.test.cjs. They use separate test data directories.

Skin support: src/main/skins.js validates standard PNG skins, creates cached head avatars with the overlay, and uploads multipart PNGs to Minecraft Services. src/main/auth.js binds uploads to a Microsoft account and refreshes the profile without exposing tokens. IPC keeps the selected file in a short-lived main-process draft; src/renderer/skin-dialog.js provides model selection and explicit upload. account-head.js uses local data images with a fallback. SkinsRestorer integration generates a command for the user to run on their server; it does not claim control over server permissions or caches.
Skin checks: tools/skin-check.cjs, optionally --release. Tests read the existing official texture but never change the real account's skin; writes use a fixture transport and isolated userData.

Offline skins (1.0.3): the same upload dialog publishes to the MineSkin v2 queue, polls the job and extracts a textures.minecraft.net URL. It never uses Microsoft credentials for offline accounts. Optional user-supplied MineSkin keys exist only for the request and are not persisted. auth stores offlineSkin (URL, variant, cached head); renderer provides the command to apply in server chat. No client-side injection into Minecraft or server permission bypass is used.
