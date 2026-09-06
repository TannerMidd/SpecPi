# SpecPi Chat development

For setup and everyday use, see the [overview](README.md) and [user guide](GUIDE.md).

## Development and checks

The extension is plain CommonJS JavaScript; no compilation or dependency installation is needed for packaging.

```sh
npm --prefix vscode run check
npm --prefix vscode test
npm --prefix vscode run test:host
npm --prefix vscode run test:vsix
npm --prefix vscode run test:render
npm --prefix vscode run package
```

The host tests use the installed VS Code executable. Set `VSCODE_EXECUTABLE` to its absolute path if automatic detection fails. They create a temporary workspace, user-data directory, extension directory, and `PI_CODING_AGENT_DIR`, then launch a deterministic fake Pi process. No installed Pi profile or provider is used. `test:vsix` also verifies that VS Code accepts the packaged VSIX, installs it into the isolated extensions directory, and runs the same host suite against those installed files. Successful tests remove the temporary profile; failures retain it and report its path for inspection.

The initial preview was exercised with VS Code **1.136.1 on Windows**, including VSIX installation, the real webview ready handshake, command registration, editor attachments, RPC streaming and tools, model controls, session retention, Stop, and New Chat. Provider-backed requests are outside the deterministic fixture's coverage.

Rendering checks use the repository's reviewed browser runtime. Run `npm run setup:browser` from the repository root if it has not been provisioned. `test:render` enables the dedicated viewport/theme tests and saves review screenshots under `.specpi-test/vscode/screenshots`; it does not replace visual baselines.

If a crash leaves **session catalog is locked**, first ensure no VS Code window is saving that workspace's chat history. Close those windows and remove only the affected `catalog.lock` directory from SpecPi Chat's VS Code workspace storage before reopening. Keep `catalog.json` and `sessions` intact. The extension does not silently break a lock that could belong to another active window.

To explore the sidebar interactively with that same isolated fixture:

```sh
npm --prefix vscode run dev
```

This opens a separate development host with a fake agent and retains the temporary profile. Close the window when finished. The fixture only demonstrates UI behavior; it does not contact a model or execute tools.

For development against your configured Pi, explicitly launch the source extension in your chosen workspace:

```sh
code --extensionDevelopmentPath="<absolute-path-to-SpecPi>/vscode" "<your-workspace>"
```

Use the normal connection controls to start Pi. Run full repository validation with `npm run check` before considering the change complete. Packaging uses an exact source allowlist and deterministic ZIP metadata; generated VSIX files remain under the repository's ignored `.specpi-test/vscode` directory.

## Publishing

After validation, run `npm --prefix vscode run package` and upload the resulting VSIX through the [Marketplace publisher dashboard](https://marketplace.visualstudio.com/manage/publishers/) for `tannermidd`. For the first publication, choose **New extension → Visual Studio Code**; for later versions, update the existing extension. Check the dashboard's validation result and the public listing before announcing availability. Packaging alone does not publish anything.

The manifest's `private: true` prevents accidental npm publication; the VS Code Marketplace uses the VSIX and its publisher identity. Publisher sign-in is separate from Pi authentication. Do not put publishing credentials in the repository.
