// Salesforce Bulk Field Creator — Content Script
// Detects Fields & Relationships page, injects button + modal.

(() => {
  'use strict';

  const BUTTON_ID = 'sfbc-bulk-add-btn';
  const MODAL_ID = 'sfbc-modal-overlay';

  let currentObjectId = null;     // from URL segment
  let resolvedObjectApi = null;   // after resolveObjectName
  let sfHost = null;              // e.g. "myorg.lightning.force.com"
  let fieldCounter = 0;
  let permissionSetsCache = null;

  // ─── Page Detection ─────────────────────────────────────────────────────

  function isFieldsAndRelationshipsPage() {
    return /\/lightning\/setup\/ObjectManager\/[^/]+\/FieldsAndRelationships/i.test(location.href);
  }

  function extractObjectId() {
    const m = location.href.match(/ObjectManager\/([^/]+)/);
    return m ? m[1] : null;
  }

  function getSfHost() {
    return location.hostname;
  }

  // ─── Message helpers ────────────────────────────────────────────────────

  function sendMsg(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, resp => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (resp && resp.error) {
          reject(new Error(resp.error));
        } else {
          resolve(resp);
        }
      });
    });
  }

  // ─── Button Injection ──────────────────────────────────────────────────

  function injectButton() {
    if (document.getElementById(BUTTON_ID)) return;

    // Strategy: find the visible Quick Find or the button group
    // (page-header-actions) in the Fields & Relationships header.
    // There can be multiple Quick Find inputs (sidebar vs main content) —
    // we need the VISIBLE one in the main content area.
    const targets = [
      // The button group that contains "New", "Deleted Fields", etc.
      () => document.querySelector('.page-header-actions.slds-button-group'),
      // Visible Quick Find input — skip zero-width sidebar ones
      () => {
        const inputs = document.querySelectorAll(
          'input[placeholder*="Quick Find"], input[placeholder*="quick find"], input[name="search-input"]'
        );
        for (const input of inputs) {
          if (input.getBoundingClientRect().width > 0) {
            return input.closest('.objectManagerGlobalSearchBox, .slds-form-element')
              || input.closest('.slds-col')?.parentElement;
          }
        }
        return null;
      },
      // Generic action bar at top of list
      () => document.querySelector('.listContent .controls, .forceListViewManagerHeader .actionBarLeft, .flexipageHeader'),
    ];

    let anchor = null;
    for (const fn of targets) {
      anchor = fn();
      if (anchor) break;
    }

    if (!anchor) return; // not ready yet — will retry via observer

    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.className = 'sfbc-inject-btn';
    btn.innerHTML = `<svg viewBox="0 0 20 20"><path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"/></svg> Bulk Add Fields`;
    btn.addEventListener('click', openModal);

    anchor.insertBefore(btn, anchor.firstChild);
  }

  // ─── Modal Construction ────────────────────────────────────────────────

  function openModal() {
    if (document.getElementById(MODAL_ID)) return;

    sfHost = getSfHost();
    currentObjectId = extractObjectId();
    resolvedObjectApi = null;
    fieldCounter = 0;
    permissionSetsCache = null;

    const overlay = document.createElement('div');
    overlay.id = MODAL_ID;
    overlay.className = 'sfbc-overlay';
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

    overlay.innerHTML = buildModalHTML();
    document.body.appendChild(overlay);

    // Bind events
    overlay.querySelector('.sfbc-close').addEventListener('click', closeModal);
    overlay.querySelector('#sfbc-cancel-btn').addEventListener('click', closeModal);
    overlay.querySelector('#sfbc-add-field-btn').addEventListener('click', () => addFieldRow());
    overlay.querySelector('#sfbc-create-btn').addEventListener('click', handleCreate);
    overlay.querySelector('#sfbc-perm-toggle').addEventListener('click', togglePermSection);
    overlay.querySelector('#sfbc-perm-search').addEventListener('input', filterPermSets);

    // Keyboard — Escape closes
    overlay._keyHandler = e => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', overlay._keyHandler);

    // Add first field row
    addFieldRow();

    // Resolve object name + load perm sets
    resolveObject();
    loadPermissionSets();
  }

  function buildModalHTML() {
    const objDisplay = currentObjectId || '…';
    return `
      <div class="sfbc-modal">
        <div class="sfbc-header">
          <div class="sfbc-header-left">
            <h2 class="sfbc-title">Bulk Add Fields</h2>
            <span class="sfbc-subtitle" id="sfbc-object-label">Object: ${escapeHtml(objDisplay)}</span>
          </div>
          <button class="sfbc-close" title="Close">&times;</button>
        </div>
        <div class="sfbc-body">
          <div id="sfbc-fields-container"></div>
          <button class="sfbc-add-field" id="sfbc-add-field-btn">+ Add Another Field</button>

          <!-- Permission Sets -->
          <div class="sfbc-perm-section">
            <button class="sfbc-perm-toggle" id="sfbc-perm-toggle">
              <span class="sfbc-chevron">&#9654;</span>
              Assign to Permission Sets
            </button>
            <div class="sfbc-perm-body" id="sfbc-perm-body">
              <input type="text" class="sfbc-input sfbc-perm-search" id="sfbc-perm-search" placeholder="Filter permission sets…">
              <div class="sfbc-perm-list" id="sfbc-perm-list">
                <div class="sfbc-perm-loading">Loading permission sets…</div>
              </div>
            </div>
          </div>

          <!-- Progress (hidden until creation) -->
          <div id="sfbc-progress-area" style="display:none">
            <div class="sfbc-progress" id="sfbc-progress-list"></div>
            <div id="sfbc-summary"></div>
          </div>
        </div>
        <div class="sfbc-footer">
          <button class="sfbc-btn sfbc-btn-neutral" id="sfbc-cancel-btn">Cancel</button>
          <button class="sfbc-btn sfbc-btn-brand" id="sfbc-create-btn">Create Fields</button>
        </div>
      </div>`;
  }

  function closeModal() {
    const overlay = document.getElementById(MODAL_ID);
    if (overlay) {
      document.removeEventListener('keydown', overlay._keyHandler);
      overlay.remove();
    }
  }

  // ─── Object Resolution ─────────────────────────────────────────────────

  async function resolveObject() {
    if (!currentObjectId) return;
    try {
      const result = await sendMsg({ action: 'resolveObjectName', sfHost, objectIdOrName: currentObjectId });
      resolvedObjectApi = result.objectApiName;
      const label = document.getElementById('sfbc-object-label');
      if (label) label.textContent = `Object: ${resolvedObjectApi}`;
    } catch (err) {
      // If resolution fails, use the raw value from the URL
      resolvedObjectApi = currentObjectId;
    }
  }

  // ─── Permission Sets ───────────────────────────────────────────────────

  async function loadPermissionSets() {
    const list = document.getElementById('sfbc-perm-list');
    if (!list) return;

    try {
      const result = await sendMsg({ action: 'getPermissionSets', sfHost });
      permissionSetsCache = result.records || [];
      renderPermSets(permissionSetsCache);
    } catch (err) {
      list.innerHTML = `<div class="sfbc-perm-loading" style="color:#ba0517">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderPermSets(sets) {
    const list = document.getElementById('sfbc-perm-list');
    if (!list) return;
    if (!sets.length) {
      list.innerHTML = '<div class="sfbc-perm-loading">No permission sets found.</div>';
      return;
    }
    list.innerHTML = sets.map(ps => `
      <div class="sfbc-perm-item">
        <label><input type="checkbox" data-ps-id="${escapeAttr(ps.Id)}" data-ps-name="${escapeAttr(ps.Label)}"> ${escapeHtml(ps.Label)}</label>
        <div class="sfbc-perm-access">
          <label><input type="checkbox" data-access="read" checked disabled> Read</label>
          <label><input type="checkbox" data-access="edit"> Edit</label>
        </div>
      </div>
    `).join('');
  }

  function filterPermSets() {
    const q = (document.getElementById('sfbc-perm-search')?.value || '').toLowerCase();
    if (!permissionSetsCache) return;
    renderPermSets(permissionSetsCache.filter(ps => ps.Label.toLowerCase().includes(q)));
  }

  function togglePermSection() {
    const toggle = document.getElementById('sfbc-perm-toggle');
    const body = document.getElementById('sfbc-perm-body');
    if (!toggle || !body) return;
    const isOpen = toggle.classList.toggle('sfbc-expanded');
    body.classList.toggle('sfbc-open', isOpen);
  }

  function getSelectedPermSets() {
    const items = document.querySelectorAll('#sfbc-perm-list input[data-ps-id]:checked');
    return Array.from(items).map(cb => {
      const row = cb.closest('.sfbc-perm-item');
      const editCb = row.querySelector('input[data-access="edit"]');
      return {
        parentId: cb.dataset.psId,
        name: cb.dataset.psName,
        edit: editCb ? editCb.checked : false,
      };
    });
  }

  // ─── Field Rows ────────────────────────────────────────────────────────

  const DATA_TYPES = [
    { value: '', label: 'Select data type' },
    { value: 'Text', label: 'Text' },
    { value: 'TextArea', label: 'Text Area' },
    { value: 'LongTextArea', label: 'Long Text Area' },
    { value: 'Number', label: 'Number' },
    { value: 'Currency', label: 'Currency' },
    { value: 'Percent', label: 'Percent' },
    { value: 'Date', label: 'Date' },
    { value: 'DateTime', label: 'Date/Time' },
    { value: 'Checkbox', label: 'Checkbox' },
    { value: 'Picklist', label: 'Picklist' },
    { value: 'MultiselectPicklist', label: 'Multi-Select Picklist' },
    { value: 'Email', label: 'Email' },
    { value: 'Phone', label: 'Phone' },
    { value: 'Url', label: 'URL' },
    { value: 'Lookup', label: 'Lookup Relationship' },
    { value: 'MasterDetail', label: 'Master-Detail Relationship' },
  ];

  function addFieldRow() {
    fieldCounter++;
    const container = document.getElementById('sfbc-fields-container');
    if (!container) return;

    const row = document.createElement('div');
    row.className = 'sfbc-field-row';
    row.dataset.fieldIdx = fieldCounter;

    const typeOpts = DATA_TYPES.map(t => `<option value="${t.value}">${t.label}</option>`).join('');

    row.innerHTML = `
      <div class="sfbc-field-row-header">
        <span class="sfbc-field-num">Field ${fieldCounter}</span>
        <button class="sfbc-remove-row" title="Remove">&times;</button>
      </div>
      <div class="sfbc-field-main">
        <div class="sfbc-form-group">
          <label class="sfbc-label sfbc-label-required">Field Label</label>
          <input type="text" class="sfbc-input" data-name="label" placeholder="e.g. Invoice Number">
        </div>
        <div class="sfbc-form-group">
          <label class="sfbc-label sfbc-label-required">API Name</label>
          <input type="text" class="sfbc-input" data-name="apiName" placeholder="Auto-generated">
        </div>
        <div class="sfbc-form-group">
          <label class="sfbc-label sfbc-label-required">Data Type</label>
          <select class="sfbc-select" data-name="type">${typeOpts}</select>
        </div>
      </div>
      <div class="sfbc-field-checks">
        <label class="sfbc-checkbox-label"><input type="checkbox" data-name="required"> Required</label>
        <label class="sfbc-checkbox-label"><input type="checkbox" data-name="unique"> Unique</label>
        <label class="sfbc-checkbox-label"><input type="checkbox" data-name="externalId"> External ID</label>
      </div>
      <button class="sfbc-advanced-toggle" data-toggle="adv">&#9660; Advanced options</button>
      <div class="sfbc-advanced-section" data-section="adv">
        <div class="sfbc-advanced-grid">
          <div class="sfbc-form-group">
            <label class="sfbc-label">Description</label>
            <textarea class="sfbc-textarea" data-name="description" rows="2"></textarea>
          </div>
          <div class="sfbc-form-group">
            <label class="sfbc-label">Help Text</label>
            <input type="text" class="sfbc-input" data-name="helpText" placeholder="Tooltip for users">
          </div>
        </div>
        <div class="sfbc-field-checks" style="margin-top:8px">
          <label class="sfbc-checkbox-label"><input type="checkbox" data-name="trackHistory"> Track History</label>
        </div>
      </div>
      <div class="sfbc-type-specific" data-section="typeSpecific"></div>
    `;

    // Remove button
    row.querySelector('.sfbc-remove-row').addEventListener('click', () => {
      row.remove();
      renumberRows();
    });

    // Label → API Name auto-generation
    const labelInput = row.querySelector('[data-name="label"]');
    const apiInput = row.querySelector('[data-name="apiName"]');
    labelInput.addEventListener('input', () => {
      if (!apiInput.dataset.userEdited) {
        const apiName = labelInput.value.trim()
          .replace(/[^a-zA-Z0-9]/g, '_')
          .replace(/_{2,}/g, '_')
          .replace(/^_+|_+$/g, '')
          .substring(0, 40);
        apiInput.value = apiName ? apiName + '__c' : '';
      }
    });
    apiInput.addEventListener('input', () => { apiInput.dataset.userEdited = '1'; });

    // Type change → type-specific fields
    row.querySelector('[data-name="type"]').addEventListener('change', e => {
      renderTypeSpecific(row, e.target.value);
    });

    // Advanced toggle
    row.querySelector('[data-toggle="adv"]').addEventListener('click', function () {
      const sec = row.querySelector('[data-section="adv"]');
      sec.classList.toggle('sfbc-open');
      this.innerHTML = sec.classList.contains('sfbc-open') ? '&#9650; Hide advanced' : '&#9660; Advanced options';
    });

    container.appendChild(row);
  }

  function renumberRows() {
    document.querySelectorAll('#sfbc-fields-container .sfbc-field-row').forEach((row, i) => {
      row.querySelector('.sfbc-field-num').textContent = `Field ${i + 1}`;
    });
  }

  // ─── Type-Specific Fields ──────────────────────────────────────────────

  function renderTypeSpecific(row, type) {
    const container = row.querySelector('[data-section="typeSpecific"]');
    container.innerHTML = '';

    if (['Text', 'TextArea'].includes(type)) {
      container.innerHTML = `
        <div class="sfbc-type-specific-grid">
          <div class="sfbc-form-group">
            <label class="sfbc-label">Length</label>
            <input type="number" class="sfbc-input" data-name="length" min="1" max="255" value="255">
          </div>
        </div>`;
    } else if (type === 'LongTextArea') {
      container.innerHTML = `
        <div class="sfbc-type-specific-grid">
          <div class="sfbc-form-group">
            <label class="sfbc-label">Length</label>
            <input type="number" class="sfbc-input" data-name="length" min="256" max="131072" value="32768">
          </div>
          <div class="sfbc-form-group">
            <label class="sfbc-label">Visible Lines</label>
            <input type="number" class="sfbc-input" data-name="visibleLines" min="2" max="50" value="6">
          </div>
        </div>`;
    } else if (['Number', 'Currency', 'Percent'].includes(type)) {
      container.innerHTML = `
        <div class="sfbc-type-specific-grid">
          <div class="sfbc-form-group">
            <label class="sfbc-label">Length (precision)</label>
            <input type="number" class="sfbc-input" data-name="precision" min="1" max="18" value="18">
          </div>
          <div class="sfbc-form-group">
            <label class="sfbc-label">Decimal Places</label>
            <input type="number" class="sfbc-input" data-name="scale" min="0" max="9" value="0">
          </div>
        </div>`;
    } else if (['Picklist', 'MultiselectPicklist'].includes(type)) {
      container.innerHTML = `
        <div class="sfbc-form-group">
          <label class="sfbc-label">Picklist Values</label>
          <div class="sfbc-picklist-values" data-name="picklistValues">
            <div class="sfbc-picklist-value-row">
              <input type="text" class="sfbc-input" placeholder="Value">
              <button class="sfbc-remove-value" title="Remove">&times;</button>
            </div>
          </div>
          <button class="sfbc-add-value">+ Add Value</button>
        </div>`;
      bindPicklistEvents(container);
    } else if (['Lookup', 'MasterDetail'].includes(type)) {
      container.innerHTML = `
        <div class="sfbc-type-specific-grid">
          <div class="sfbc-form-group">
            <label class="sfbc-label sfbc-label-required">Related To (Object API Name)</label>
            <input type="text" class="sfbc-input" data-name="referenceTo" placeholder="e.g. Contact">
          </div>
          <div class="sfbc-form-group">
            <label class="sfbc-label">Relationship Name</label>
            <input type="text" class="sfbc-input" data-name="relationshipName" placeholder="Auto-generated from API name">
          </div>
        </div>`;
    }
  }

  function bindPicklistEvents(container) {
    container.querySelector('.sfbc-add-value').addEventListener('click', () => {
      const list = container.querySelector('.sfbc-picklist-values');
      const row = document.createElement('div');
      row.className = 'sfbc-picklist-value-row';
      row.innerHTML = `<input type="text" class="sfbc-input" placeholder="Value"><button class="sfbc-remove-value" title="Remove">&times;</button>`;
      row.querySelector('.sfbc-remove-value').addEventListener('click', () => row.remove());
      list.appendChild(row);
    });
    container.querySelectorAll('.sfbc-remove-value').forEach(btn => {
      btn.addEventListener('click', () => btn.closest('.sfbc-picklist-value-row').remove());
    });
  }

  // ─── Collect Field Data ────────────────────────────────────────────────

  function collectFieldData(row) {
    const val = name => {
      const el = row.querySelector(`[data-name="${name}"]`);
      if (!el) return undefined;
      if (el.type === 'checkbox') return el.checked;
      return el.value.trim();
    };

    const label = val('label');
    const apiName = val('apiName');
    const type = val('type');

    if (!label || !apiName || !type) return null;

    const metadata = {
      label,
      type,
      required: val('required') || false,
      unique: val('unique') || false,
      externalId: val('externalId') || false,
      description: val('description') || '',
      inlineHelpText: val('helpText') || '',
      trackHistory: val('trackHistory') || false,
    };

    // Type-specific
    switch (type) {
      case 'Text':
      case 'TextArea':
        metadata.length = parseInt(val('length')) || 255;
        break;
      case 'LongTextArea':
        metadata.length = parseInt(val('length')) || 32768;
        metadata.visibleLines = parseInt(val('visibleLines')) || 6;
        break;
      case 'Number':
      case 'Currency':
      case 'Percent':
        metadata.precision = parseInt(val('precision')) || 18;
        metadata.scale = parseInt(val('scale')) || 0;
        break;
      case 'Checkbox':
        metadata.defaultValue = 'false';
        break;
      case 'Picklist':
      case 'MultiselectPicklist': {
        const values = [];
        row.querySelectorAll('.sfbc-picklist-value-row input').forEach(inp => {
          if (inp.value.trim()) values.push(inp.value.trim());
        });
        if (values.length) {
          metadata.valueSet = {
            restricted: true,
            valueSetDefinition: {
              sorted: false,
              value: values.map((v, i) => ({ fullName: v, default: i === 0, label: v })),
            },
          };
        }
        break;
      }
      case 'Lookup':
        metadata.referenceTo = val('referenceTo') || '';
        metadata.relationshipName = val('relationshipName') || apiName.replace(/__c$/i, '').replace(/\W/g, '');
        metadata.relationshipLabel = metadata.relationshipName;
        metadata.deleteConstraint = 'SetNull';
        break;
      case 'MasterDetail':
        metadata.referenceTo = val('referenceTo') || '';
        metadata.relationshipName = val('relationshipName') || apiName.replace(/__c$/i, '').replace(/\W/g, '');
        metadata.relationshipLabel = metadata.relationshipName;
        break;
    }

    return { apiName, metadata };
  }

  // ─── Create Fields ─────────────────────────────────────────────────────

  async function handleCreate() {
    const rows = document.querySelectorAll('#sfbc-fields-container .sfbc-field-row');
    if (!rows.length) return;

    // Collect & validate
    const fields = [];
    for (const row of rows) {
      const data = collectFieldData(row);
      if (!data) {
        alert('Please fill in Label, API Name, and Data Type for all fields.');
        return;
      }
      fields.push(data);
    }

    // Ensure object name is resolved
    if (!resolvedObjectApi) {
      try {
        const result = await sendMsg({ action: 'resolveObjectName', sfHost, objectIdOrName: currentObjectId });
        resolvedObjectApi = result.objectApiName;
      } catch {
        resolvedObjectApi = currentObjectId;
      }
    }

    const selectedPermSets = getSelectedPermSets();

    // Disable buttons, show progress
    const createBtn = document.getElementById('sfbc-create-btn');
    const cancelBtn = document.getElementById('sfbc-cancel-btn');
    const addBtn = document.getElementById('sfbc-add-field-btn');
    createBtn.disabled = true;
    cancelBtn.disabled = true;
    addBtn.style.display = 'none';

    const progressArea = document.getElementById('sfbc-progress-area');
    const progressList = document.getElementById('sfbc-progress-list');
    progressArea.style.display = 'block';

    // Build progress items
    progressList.innerHTML = fields.map((f, i) => `
      <div class="sfbc-progress-item sfbc-status-pending" data-prog-idx="${i}">
        <span class="sfbc-status-icon">&#9679;</span>
        <span class="sfbc-status-msg">${escapeHtml(f.metadata.label)} (${escapeHtml(f.apiName)})</span>
        <span class="sfbc-status-detail"></span>
      </div>
    `).join('');

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const progItem = progressList.querySelector(`[data-prog-idx="${i}"]`);

      // Update to "creating"
      progItem.className = 'sfbc-progress-item sfbc-status-creating';
      progItem.querySelector('.sfbc-status-icon').innerHTML = '&#10227;';
      progItem.querySelector('.sfbc-status-detail').textContent = 'Creating…';

      try {
        const fullName = `${resolvedObjectApi}.${f.apiName}`;
        await sendMsg({
          action: 'createField',
          sfHost,
          fieldPayload: { fullName, metadata: f.metadata },
        });

        // Field created — now assign permissions
        if (selectedPermSets.length) {
          progItem.querySelector('.sfbc-status-detail').textContent = 'Assigning permissions…';
          for (const ps of selectedPermSets) {
            try {
              await sendMsg({
                action: 'assignFieldPermissions',
                sfHost,
                permPayload: {
                  parentId: ps.parentId,
                  sobjectType: resolvedObjectApi,
                  field: f.apiName,
                  read: true,
                  edit: ps.edit,
                },
              });
            } catch (permErr) {
              // Non-fatal — log but don't fail the field
              console.warn(`Permission assignment failed for ${f.apiName} → ${ps.name}:`, permErr.message);
            }
          }
        }

        progItem.className = 'sfbc-progress-item sfbc-status-success';
        progItem.querySelector('.sfbc-status-icon').innerHTML = '&#10003;';
        progItem.querySelector('.sfbc-status-detail').textContent = 'Created';
        successCount++;

      } catch (err) {
        progItem.className = 'sfbc-progress-item sfbc-status-error';
        progItem.querySelector('.sfbc-status-icon').innerHTML = '&#10007;';
        progItem.querySelector('.sfbc-status-detail').textContent = err.message;
        errorCount++;
      }

      // Small delay between fields to respect rate limits
      if (i < fields.length - 1) {
        await new Promise(r => setTimeout(r, 350));
      }
    }

    // Summary
    const summary = document.getElementById('sfbc-summary');
    if (errorCount === 0) {
      summary.className = 'sfbc-summary sfbc-summary-success';
      summary.textContent = `All ${successCount} field(s) created successfully!`;
    } else if (successCount > 0) {
      summary.className = 'sfbc-summary sfbc-summary-partial';
      summary.textContent = `${successCount} created, ${errorCount} failed.`;
    } else {
      summary.className = 'sfbc-summary sfbc-summary-error';
      summary.textContent = `All ${errorCount} field(s) failed.`;
    }

    // Re-enable cancel (as "Close") and add refresh button
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Close';
    createBtn.textContent = 'Refresh Page';
    createBtn.disabled = false;
    createBtn.onclick = () => { location.reload(); };
  }

  // ─── Utilities ─────────────────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ─── SPA-aware Initialization ──────────────────────────────────────────

  function tryInit() {
    if (isFieldsAndRelationshipsPage()) {
      injectButton();
    } else {
      // Remove button if we navigated away
      const btn = document.getElementById(BUTTON_ID);
      if (btn) btn.remove();
    }
  }

  // Initial check
  tryInit();

  // Observe DOM mutations (Salesforce SPA renders content dynamically)
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      tryInit();
    }
    // Also retry injection if button disappeared (SF re-renders sections)
    if (isFieldsAndRelationshipsPage() && !document.getElementById(BUTTON_ID)) {
      injectButton();
    }
  });

  observer.observe(document.documentElement, { subtree: true, childList: true });
})();
