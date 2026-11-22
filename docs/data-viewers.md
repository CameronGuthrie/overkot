# Data viewers

Enable **Data - Inventory** and **Data - EE.log** in Widgets, then open them from the dock. Hold Shift to move or resize a viewer. Both viewers scroll inside their windows and preserve their chosen size.

Inventory groups the entire saved response into alphabetical sections. Item names are resolved from local game labels and owned-item references where possible; unfamiliar identifiers receive readable fallback labels. Search includes original fields, paths, IDs and values. Expand an entry to see coloured fields, nested lists and its original JSON. The section selector and Show more button help with large inventories.

EE.log separates elapsed session times, categories, severity and messages. Search combines words, and the level selector filters errors, warnings, information or debug messages. Entries open to show structured details when available and the original text. Change between newest-first and oldest-first order.

These are snapshots. Opening reads the current source; **Refresh** reads it again. Inventory refresh requests a new response through the existing connected game session, sharing any in-flight poll. When disconnected, the last encrypted inventory cache remains readable and is labelled as saved data. The displayed update time belongs to the inventory source; the read time records when this viewer loaded it. EE.log uses the location detected by the app or configured in Settings. It shows the latest 2 MiB / 2,000 entries, with a notice when older data is omitted.

Source reads and parsing stay in the main process. Viewers do not start background file watchers or an additional network polling loop. Missing files, offline refreshes and read failures are shown inside the viewer; a failed refresh retains the previous successful snapshot.
