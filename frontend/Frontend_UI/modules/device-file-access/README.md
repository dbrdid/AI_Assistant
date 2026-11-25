# device-file-access

Expo local module for selecting original device files and folders without copying file contents.

- Android uses the Storage Access Framework and retains persistable URI permissions.
- iOS uses the Files document picker with `asCopy: false` and stores security-scoped bookmarks.
- Android opens the Downloads folder first. On iOS, select Downloads in Files; the selected folder is remembered for later saves.
- Files selected for the library remain references to their original locations. App-created files are copied to the selected save folder.
- Requires a rebuilt native app; this module is not available in Expo Go.
