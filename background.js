// Salesforce Bulk Field Creator — Background Service Worker
// All Salesforce API calls are proxied through here to leverage cookie access and avoid CORS.

const API_VERSION = 'v66.0';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    sendResponse({ error: err.message || String(err) });
  });
  return true; // async response
});

async function handleMessage(msg, sender) {
  switch (msg.action) {
    case 'getSession':
      return getSession(msg.sfHost);
    case 'resolveObjectName':
      return resolveObjectName(msg.sfHost, msg.objectIdOrName);
    case 'createField':
      return createField(msg.sfHost, msg.fieldPayload);
    case 'getPermissionSets':
      return getPermissionSets(msg.sfHost);
    case 'getPermissionSetObjectAccessIds':
      return getPermissionSetObjectAccessIds(msg.sfHost, msg.sobjectType);
    case 'assignFieldPermissions':
      return assignFieldPermissions(msg.sfHost, msg.permPayload);
    default:
      throw new Error(`Unknown action: ${msg.action}`);
  }
}

// ─── Session ────────────────────────────────────────────────────────────────

async function getSession(sfHost) {
  const url = `https://${sfHost}`;
  const cookie = await chrome.cookies.get({ url, name: 'sid' });
  if (!cookie) {
    throw new Error('No Salesforce session found. Make sure you are logged in.');
  }
  return { sessionId: cookie.value };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function sfApiCall(sfHost, { method = 'GET', path, body, sessionId }) {
  if (!sessionId) {
    const session = await getSession(sfHost);
    sessionId = session.sessionId;
  }

  const url = `https://${sfHost}/services/data/${API_VERSION}${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${sessionId}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);
  const text = await resp.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!resp.ok) {
    const errMsg = Array.isArray(data)
      ? data.map(e => e.message || e.errorCode).join('; ')
      : (data?.message || data?.[0]?.message || `HTTP ${resp.status}`);
    throw new Error(errMsg);
  }
  return data;
}

async function sfQuery(sfHost, soql, sessionId) {
  const path = `/query/?q=${encodeURIComponent(soql)}`;
  return sfApiCall(sfHost, { path, sessionId });
}

async function sfToolingQuery(sfHost, soql, sessionId) {
  const path = `/tooling/query/?q=${encodeURIComponent(soql)}`;
  return sfApiCall(sfHost, { path, sessionId });
}

// ─── Resolve Object Name ────────────────────────────────────────────────────

async function resolveObjectName(sfHost, objectIdOrName) {
  // Standard or custom object API names pass through directly
  // DurableIds look like 15/18-char Salesforce IDs (alphanumeric, start with a key prefix)
  const looksLikeId = /^[a-zA-Z0-9]{15,18}$/.test(objectIdOrName) &&
                      !objectIdOrName.includes('__');

  if (!looksLikeId) {
    return { objectApiName: objectIdOrName };
  }

  const soql = `SELECT QualifiedApiName FROM EntityDefinition WHERE DurableId = '${objectIdOrName}' LIMIT 1`;
  const result = await sfToolingQuery(sfHost, soql);

  if (result.records && result.records.length > 0) {
    return { objectApiName: result.records[0].QualifiedApiName };
  }
  // Fallback — treat as API name
  return { objectApiName: objectIdOrName };
}

// ─── Create Field ───────────────────────────────────────────────────────────

async function createField(sfHost, fieldPayload) {
  // fieldPayload: { fullName, metadata }
  //   fullName = "ObjectApiName.FieldName__c"
  //   metadata = { label, type, length, ... }
  const body = {
    FullName: fieldPayload.fullName,
    Metadata: fieldPayload.metadata,
  };

  return sfApiCall(sfHost, {
    method: 'POST',
    path: '/tooling/sobjects/CustomField/',
    body,
  });
}

// ─── Permission Sets ────────────────────────────────────────────────────────

async function getPermissionSets(sfHost) {
  const soql = `SELECT Id, Name, Label FROM PermissionSet WHERE IsOwnedByProfile = false AND Type = 'Regular' ORDER BY Label`;
  return sfQuery(sfHost, soql);
}

async function getPermissionSetObjectAccessIds(sfHost, sobjectType) {
  const soql = `SELECT ParentId FROM ObjectPermissions WHERE SobjectType = '${sobjectType}'`;
  const result = await sfQuery(sfHost, soql);
  const ids = new Set((result.records || []).map(r => r.ParentId).filter(Boolean));
  return { parentIds: Array.from(ids) };
}

// ─── Field Permissions ──────────────────────────────────────────────────────

async function assignFieldPermissions(sfHost, permPayload) {
  // permPayload: { parentId, sobjectType, field, read, edit }

  // Ensure the permission set has object-level access first.
  // Without ObjectPermissions the FieldPermissions insert will fail with
  // "invalid cross reference id".
  await ensureObjectPermissions(sfHost, permPayload.parentId, permPayload.sobjectType);

  const body = {
    ParentId: permPayload.parentId,
    SobjectType: permPayload.sobjectType,
    Field: `${permPayload.sobjectType}.${permPayload.field}`,
    PermissionsRead: permPayload.read !== false,
    PermissionsEdit: permPayload.edit === true,
  };

  return sfApiCall(sfHost, {
    method: 'POST',
    path: '/sobjects/FieldPermissions/',
    body,
  });
}

async function ensureObjectPermissions(sfHost, parentId, sobjectType) {
  // Check if ObjectPermissions already exist for this permission set + object
  const soql = `SELECT Id FROM ObjectPermissions WHERE ParentId = '${parentId}' AND SobjectType = '${sobjectType}' LIMIT 1`;
  const result = await sfQuery(sfHost, soql);

  if (result.records && result.records.length > 0) {
    return; // already has object access
  }

  // Create minimal object permissions (read access) so field permissions can be assigned
  const body = {
    ParentId: parentId,
    SobjectType: sobjectType,
    PermissionsRead: true,
    PermissionsViewAllRecords: false,
    PermissionsEdit: false,
    PermissionsCreate: false,
    PermissionsDelete: false,
    PermissionsModifyAllRecords: false,
  };

  return sfApiCall(sfHost, {
    method: 'POST',
    path: '/sobjects/ObjectPermissions/',
    body,
  });
}
