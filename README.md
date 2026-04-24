# Salesforce Bulk Field Creator

Chrome extension for Salesforce admins to bulk-create custom fields from Object Manager.

## Privacy Policy

Last updated: April 24, 2026

This Privacy Policy explains how Salesforce Bulk Field Creator (the "Extension") collects, uses, and shares user data.

### 1. What this Extension does

The Extension adds a UI on Salesforce Object Manager pages to let a logged-in Salesforce admin create multiple custom fields and optionally assign field permissions to selected permission sets.

### 2. Data the Extension collects and processes

The Extension processes the following categories of data:

1. Salesforce page context data
- Current Salesforce host/domain (for example, your-org.lightning.force.com).
- Current object identifier or API name from the active Salesforce setup URL.

2. User-provided configuration data
- Field labels, API names, data types, required/unique/external-id flags.
- Advanced field options (description, help text, history tracking, picklist values, relationship settings).
- Permission assignment selections (permission set selection and edit/read choices).

3. Salesforce authentication/session data
- Your Salesforce session cookie value (sid) is read by the extension background service worker via the Chrome cookies API.
- This value is used only to authorize API calls to your Salesforce org as the currently logged-in user.

4. API response and operational data
- Responses and error messages returned by Salesforce REST and Tooling APIs.
- Temporary progress/status state shown in the extension modal.

5. Local extension state
- The extension has the storage permission and may store lightweight local state needed for extension operation (for example, UI state or cached lists).

### 3. How data is used

Data is used strictly to provide requested extension functionality:

1. Detect the active Salesforce setup page and target object.
2. Build Salesforce API requests to create custom fields.
3. Optionally create/check object permissions and assign field permissions.
4. Display progress, warnings, and errors back to the user.
5. Preserve extension UI behavior/state where needed.

The Extension does not use user data for advertising, profiling, or sale of data.

### 4. Where data is processed and stored

1. In-browser processing
- Most data is processed in your browser by the content script and background service worker.

2. Local storage
- Any extension state stored through Chrome extension storage remains in the user browser profile unless the user removes it.

3. Salesforce systems
- Data submitted to create fields and permissions is transmitted to Salesforce API endpoints in your org domain(s) and stored by Salesforce according to your Salesforce configuration and policies.

### 5. Data sharing and disclosure

The Extension shares data only with the following parties:

1. Salesforce, Inc. (and your Salesforce org environment)
- Recipient: Salesforce API endpoints on your org domain(s) (for example, *.salesforce.com, *.salesforce-setup.com, *.force.com, *.lightning.force.com).
- Purpose: Create custom fields, query object/permission metadata, and assign permissions.
- Data shared: Salesforce context, field configuration payloads, permission assignment payloads, and authenticated API requests using your active session.

2. Google Chrome extension platform (technical operation only)
- Recipient: Google systems used to deliver and run Chrome extensions (installation, updates, browser runtime).
- Purpose: Host and operate the extension platform.
- Data shared by this Extension intentionally: None beyond what is technically required by Chrome to install/update/run extensions.

No other third parties receive user data from this Extension.

The Extension does not intentionally transmit data to external analytics providers, ad networks, data brokers, or separate developer-owned servers.

### 6. Permissions and why they are needed

1. activeTab
- Used to operate on the currently active Salesforce setup tab.

2. scripting
- Used to run extension UI logic on Salesforce pages.

3. cookies
- Used to read Salesforce session cookie data needed to authenticate Salesforce API calls as the logged-in user.

4. storage
- Used for extension-local state needed for operation.

5. Host permissions
- Used to access Salesforce pages and Salesforce API endpoints on supported Salesforce domains.

### 7. Data retention

1. Extension-local data
- Retained in the browser only as long as needed for extension functionality or until the user clears browser/extension data or uninstalls the Extension.

2. Salesforce data
- Field definitions, permissions, and related records created through the Extension are retained in Salesforce according to Salesforce and your organization retention policies.

### 8. Security

1. Network requests are made over HTTPS to Salesforce domains.
2. The Extension does not maintain a separate developer backend for storing user Salesforce data.
3. Access scope is limited to declared permissions and host permissions.