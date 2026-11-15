# Public Linux update acceptance

The `linux-ota.yml` workflow runs original published AppImages in their built-in
extraction runtime on a disposable GitHub-hosted Ubuntu 22.04 desktop. It uses
Xvfb, Openbox, AT-SPI and native generated keyboard/pointer input. It does not
inject scripts into or modify the application package.

Pull requests run only the environment probe. It checks the original asset's
SHA-256 and size, offline and live CLI versions, and the visible Welcome tab and
filtered update command. Accessibility state can precede painting: capture waits
for the expected control's text in two actual images. Review the screenshots as
well as the assertions.

The manual `upgrade` mode requires `upgrade-test-only` acknowledgement and the
fixed reviewed pair `v1.2.1` to `v1.3.0`. It is refused outside the expected
repository's manual hosted workflow. Check workflow registration and the reviewed
branch head before dispatching:

```sh
gh workflow run linux-ota.yml --repo TunneldeDev/Tunnelde --ref <reviewed-branch> \
  -f tag=v1.2.1 -f mode=upgrade -f acknowledgement=upgrade-test-only
```

The runner seeds public preferences through the supported CLI and uses native
keyboard/pointer input in the original GUI to save a synthetic host and named
settings profile. It invokes Check for updates from F1 and activates Download
and install through native pointer input.
The application's updater performs the download, signature verification,
installation and restart. The harness does not launch a target application.
Acceptance requires the installed AppImage to match the target public asset's
digest, the target live endpoint to appear, all seeded public preference values
to survive, the complete public host and nonempty profile records to match, and
normal native close to remove the target endpoint and process. Profile inspection
opens only this attempt's canonical SQLite database in read-only mode; it never
seeds records directly. Fixture typing is ASCII and does not establish IME behavior.

This upgrade matrix does not seed nonempty history/plugin or credential data,
and does not establish their migration compatibility. It also
does not establish physical desktop behavior or all historical upgrade paths.
Failures retain logs, accessibility trees, captures and the stage report. A
forced cleanup is not a normal quit. Only this run's child groups and recorded
owned target process are eligible for cleanup; evidence remains for runner
disposal and artifact review.

Do not run this on a workstation or a self-hosted runner. The workflow token has
read-only contents permission, is used only to fetch release assets, and is
removed from the application environment. Environment guards prevent accidental
execution; they are not an attestation against someone deliberately fabricating
a hosted-runner environment.
