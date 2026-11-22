# Overkot 0.0.10 installer scan review

Reviewed on 12 September 2026. This review applies to this exact artifact, built
from the changes in commit `c9b0002`; it does not certify other builds or future
antivirus definitions.

- File: `overkot-setup-0.0.10.exe`
- Size: 91,521,618 bytes
- SHA-256: `3002d5148a07dfc89e1d801df10cafb7b5f5b7dd1a78a386a85bbac66ffb941a`
- [VirusTotal report](https://www.virustotal.com/gui/file/3002d5148a07dfc89e1d801df10cafb7b5f5b7dd1a78a386a85bbac66ffb941a)
- [MetaDefender report](https://metadefender.com/results/file/bzI2MDkxMmF4MExkVjVvZDQ0Z01PcFVaUE0z_mdaas/overview)

## Engine detections

VirusTotal displayed three detections out of 66 engines: Avast and AVG reported
`Win32:MalwareX-gen [Misc]`, and WithSecure reported `Trojan.TR/W32.Agent`.
MetaDefender reported Webroot SMD `Malware_51.3` for the installer. These are
separate engine reports; Webroot on VirusTotal did not flag the sample.

MetaDefender also flagged these extracted installer components:

| Component | Webroot SMD result | Verified provenance |
| --- | --- | --- |
| `nsExec.dll` | `Malware_50.4` | Exact match to Electron Builder's official NSIS archive |
| `WinShell.dll` | `Malware_50.8` | Exact match to Electron Builder's official NSIS resources archive |
| `Uninstall Overkot.exe` | `Malware_52.5` | Generated uninstaller; no independent upstream byte match claimed |

The two DLLs were compared against fresh downloads from the official
[NSIS release](https://github.com/electron-userland/electron-builder-binaries/releases/tag/nsis-3.0.4.1)
and [NSIS resources release](https://github.com/electron-userland/electron-builder-binaries/releases/tag/nsis-resources-3.4.1).
Both archive SHA-512 values matched the checksums pinned in the installed
`app-builder-lib/out/targets/nsis/nsisUtil.js`. The Unicode DLLs extracted from
those archives matched the report's SHA-256 values:

- `Plugins/x86-unicode/nsExec.dll` (6,656 bytes):
  `5d9ceb1ce5f35aea5f9e5a0c0edeeec04dfefe0c77890c80c70e98209b58b962`
- `plugins/x86-unicode/WinShell.dll` (3,072 bytes):
  `9be85b986ea66a6997dde658abe82b3147ed2a1a3dcb784bb5176f41d22815a6`

This establishes that those detections affect unmodified upstream components.
It does not establish what triggers the Avast, AVG or WithSecure installer
verdicts, or prove every component harmless. The app archive was absent from
MetaDefender's detected-only list; that is not proof of complete nested scanning.

## Behavior findings

VirusTotal's completed behavior view shows the stock NSIS PowerShell commands
that check whether Overkot is running before an installation or update. They
match Electron Builder's `allowOnlyOneInstallerInstance.nsh` template. The
`nsExec` plugin launches these checks; `WinShell` manages app shortcut identity
and shortcut cleanup. These operations have a legitimate installer purpose.

The PowerShell alias alert matched Windows defining `ncim` as an alias for
`New-CimInstance`. The [current upstream Sigma rule](https://github.com/SigmaHQ/sigma/blob/master/rules/windows/powershell/powershell_script/posh_ps_susp_set_alias.yml)
explicitly excludes that exact command in `filter_main_cim`. This supports
treating this particular alias match as a false positive, rather than evidence
that Overkot ships an obfuscated PowerShell payload.

The unsigned DLL load into LSASS refers to `C:\om74bcgr\dll\WWzNbUP.dll`, SHA-256
`0bf011593b5cff9f46909e5998786e30d98440bffe7251163570ca11cd38e07c`.
[VirusTotal identifies that hash as capemon.dll](https://www.virustotal.com/gui/file/0bf011593b5cff9f46909e5998786e30d98440bffe7251163570ca11cd38e07c/details).
CAPE documents its [monitor DLL injection](https://capev2.readthedocs.io/en/latest/customization/packages.html),
and its [source randomizes monitor DLL names](https://github.com/kevoreilly/CAPEv2/blob/master/analyzer/windows/lib/common/constants.py).
None of the ten EXE/DLL files in the tested unpacked application matched that
hash, and the app's ASAR contained no EXE/DLL entries. Together, this points to
sandbox instrumentation as the source of that event. It is an attribution based
on the available evidence, not a complete forensic reconstruction.

Three observed network destinations match the app's configured services:
`releases.overkot.com` for updates, `d2855gck1tg5bh.cloudfront.net` for game data,
and `europe-west2-soulframe-overlay.cloudfunctions.net` for the analytics relay.
This explains those destinations, not every network or sandbox classification.

## Remaining limits and next action

MetaDefender's public view withheld the exact YARA match and detailed behavioral
evidence behind a sign-in requirement. The public CAPE HTML listed additional
heuristics, including memory operations and a mining-pool classification, but
its Behavior tab did not expose the underlying per-process calls. Those labels
have not been individually resolved. Counts of indicators or strings alone
cannot establish what the application did.

The evidence supports requesting vendor review of the exact installer and the
two upstream DLLs. It does not justify changing hashes, stripping required
installer components, or claiming that all detections are resolved. No code or
packaging change resulted from this review, and no new installer was built.

Vendor review instructions:
[Avast](https://support.avast.com/en-us/article/submit-file-url/),
[WithSecure](https://community.withsecure.com/en/kb/articles/29360-how-to-submit-a-false-positive-or-negative-sample-file-or-url-to-withsecure),
[Webroot](https://answers.webroot.com/Webroot/ukp.aspx?app=vw&pid=17&solutionid=3867&t=Submitting-Files-to-Webroot-For-Analysis&vw=1).
Submit the exact sample with the detection name and this evidence, requesting
classification review and the specific file or behavior responsible for any
remaining verdict. No vendor submission has been sent.

See [installer and update behavior](installer-updates.md) for the build and
distribution process.

## Follow-up: Google and Varist, 14 September 2026

The maintainer reported `Google: Detected` and
`Varist: W32/ABRisk.MDWP-3217` for the 0.0.10 installer. These are newly reported
verdicts, separate from the 12 September observations above. The live engine
results were not independently retrieved during this follow-up, and neither
vendor has confirmed a false positive. The labels alone do not identify the
flagged component or prove the file safe.

The local `dist/overkot-setup-0.0.10.exe` was rechecked: its size and SHA-256 still
match the artifact recorded above. Windows `Get-AuthenticodeSignature` returned
`NotSigned`. Confirm that the current VirusTotal report has this same SHA-256
before attaching this review to a vendor request. If it differs, preserve and
review that exact sample separately.

### What the current app already does

Source review of `scripts/build-scanner.js`, `src/modules/memoryScanner.js`,
`scripts/build.js` and `package.json` confirms these existing measures:

- The scanner is compiled during the build, shipped in
  `resources/bin/hostservice.exe`, and launched directly with an argument array.
- The scanner uses `OpenProcess(0x0410)` (query information and read memory),
  `VirtualQueryEx` and `ReadProcessMemory` to recover the game account/session
  used by inventory features. The caller locates `Soulframe.x64.exe`; the helper
  does not write to the game's memory or inject code.
- The installer is per-user, with elevation and the elevation helper disabled.
- The build uses normal JavaScript minification and NSIS compression, without
  obfuscation or an additional executable packer.

Process-memory reads and an unsigned installer are plausible review points, not
confirmed explanations for these two detections. The upstream NSIS DLL matches
from the earlier review remain useful evidence for those exact DLLs. They do
not explain the Google or Varist decisions. This follow-up makes no runtime
changes intended to alter antivirus detection.

### Vendor review procedure

1. Save the installer, its SHA-256, report URL, engine labels, analysis date and
   engine versions. Request a fresh analysis of the same file to distinguish a
   stale verdict from a current detection.
2. If detections remain, request review from the responsible vendors using
   [VirusTotal's official false-positive contacts](https://docs.virustotal.com/docs/false-positive-contacts):
   **Google File Scanner:** `google-at-virustotal@google.com`;
   **Varist:** `support@varist.com` or `virus@avsubmit.com`.
   Google Safe Browsing's URL-reporting form is a separate route for flagged
   websites/download URLs, rather than this file-scanner verdict.
3. Include the exact release download, hash, detection name, this review and a
   short explanation of Overkot's game inventory integration. Ask which
   component or behavior caused the verdict. If a nested file is identified,
   provide that file and its own hash through the vendor's requested channel.
   Avoid sending player data, logs or session values with the executable.
4. Record the case number and vendor determination. Reanalyse the unchanged
   installer after a vendor correction; review a future release independently.

No requests, sample uploads or public comments have been sent by this review.

Suggested request text, after confirming the report's hash:

> Please review Overkot 0.0.10 (`overkot-setup-0.0.10.exe`) as a suspected false
> positive. SHA-256:
> `3002d5148a07dfc89e1d801df10cafb7b5f5b7dd1a78a386a85bbac66ffb941a`.
> Your engine reports [insert the engine's exact detection]. Overkot is a
> Soulframe companion overlay; its bundled helper reads the running game's
> memory to find the account/session used for inventory retrieval. The installer
> is an unsigned per-user Electron/NSIS package. Please identify the component
> or behavior responsible and review its classification. The release and source
> review are linked below: [insert the exact download, report and review links].

### Signing future releases

Use a trusted Authenticode signing identity consistently for the installer,
uninstaller, application and bundled helper. Signing establishes publisher
identity and integrity; it does not promise that Google or Varist will clear a
detection. [Microsoft's current guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
also distinguishes SmartScreen reputation from antivirus verdicts: unsigned
versions start fresh, and even signed new releases can show warnings. EV signing
no longer grants an automatic SmartScreen bypass.

The installed Electron Builder 26.8.1 supports `win.signtoolOptions` or
`win.azureSignOptions`; see its [Windows configuration](https://www.electron.build/v26/docs/win/)
and [signing guide](https://www.electron.build/v26/docs/features/code-signing/).
Its `winPackager`/`platformPackager` code passes `.exe` files in `extraResources`
through the signer, so the existing helper placement supports signing without
a second custom copy. Keep `signAndEditExecutable` enabled. Once credentials
are configured, require `forceCodeSigning: true` and verify the final installer,
installed uninstaller, `Overkot.exe` and `resources/bin/hostservice.exe` with
`Get-AuthenticodeSignature`. Generate checksums after signing and distribute
those exact bytes.

No signing service or certificate was purchased or configured here. Availability
depends on publisher type and country; consult
[Microsoft's signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
before choosing a provider. Do not rebuild or rename unchanged releases just to
obtain a different hash, or recommend disabling antivirus to users.
