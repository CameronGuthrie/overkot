# Settings and game files

Overkot 0.0.11 groups Settings into Appearance, Overlay, Widgets, Game files, and Updates. Resize the window from its edges; its size and position are remembered.

In **Game files**, each section shows whether a location was found and the path currently in use. Choose **Browse…**, select Soulframe's `EE.log` or the folder containing its `Soulframe*.jpg` screenshots, then choose **Apply location**. You can also paste a full path. **Use automatic** removes that override and restores detection.

An explicit location takes priority over automatic detection. Missing or unreadable locations are reported instead of silently switching to another account's files. Log readers switch on their next polling cycle. A screenshot-folder change cancels any pending location capture; request your map location again afterward.

Automatic screenshot discovery checks the current Windows account's Pictures folder, including redirected Pictures and OneDrive locations. If no screenshot folder exists yet, take an F6 screenshot in Soulframe first. Location capture consumes only a newly created, successfully parsed Soulframe screenshot. Existing pictures and unrecognized images are retained.

**Widgets → Avakot Market** controls saved sign-in. Disabling it removes the protected saved session while keeping the current session active. Enabling it saves the current session when Windows protected storage is available. The Market sign-in form uses the same preference. Passwords are never saved; **Sign out** ends the current Market session.

The setup installer now includes an installation-folder page. Choose a folder your Windows account can write to. App settings and caches remain in the account's Overkot data directory, so changing the installation location does not move game files or reset settings. The portable executable can be placed in any writable folder and does not run an installer.

Wiki Search uses the same title-bar style as Market, with back/forward navigation, refresh, and a button to open the current wiki page in your browser.

**Widgets → Timers → Show alerts while Overkot is hidden** allows alert popups while the overlay is hidden, minimised or in the tray. It is off by default, and Overkot must still be running. **Timer alert popup** must also be enabled.

**Widgets → Saved layouts** stores named arrangements of the bar and widgets. Arrange your widgets, enter a name, and choose **Save current as new**. A layout includes the bar edge and auto-hide choice, selected widgets and their order, open panels, docking, and panel positions and sizes. Choose a saved layout and **Apply** to restore it. **Update selected** replaces that saved arrangement with your current one; **Rename** changes only its name. Deleting a saved layout leaves the current arrangement in place. You can keep up to 50 layouts with names of up to 80 characters.

Choose **Export selected…** to save an `.overkot-layout.json` file for sharing or backup. **Import…** adds a layout to your saved list without applying it. Layout files contain arrangement settings; accounts, game-file paths, shortcuts and appearance presets stay separate. Positions are adjusted to the available displays when a layout is applied on another setup.
