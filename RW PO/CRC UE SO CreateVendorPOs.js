/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * @Author: Randy Nivert CanyonRim Consulting
 *
 * PURPOSE
 * ───────
 * Adds a "Create Vendor POs" button to the Sales Order form.
 * One click creates all vendor POs at once, replacing the current workflow
 * where employees click "Spec. Ord." on each SO line individually.
 *
 * Also adds a "Purchase Orders (N)" tab to the SO form next to the Related
 * Records tab, showing every PO created from this SO — because NetSuite's
 * native Related Records tab Special Order relationship cannot be created via
 * SuiteScript's record.create() API. The tab queries custcol_crc_created_po_id
 * stamps written by the Suitelet, so it always reflects the true linked POs.
 *
 * HOW THE BUTTON WORKS
 * ────────────────────
 * NetSuite's addButton() functionName must reference a named function on
 * window. Rather than relying on a Client Script deployment (which has
 * timing issues with pageInit), we inject a <script> tag directly into
 * the page HTML via an INLINEHTML field. This guarantees the function
 * exists on window by the time any button click can fire.
 *
 * NO companion Client Script file is needed.
 *
 * DEPLOYMENT
 * ──────────
 *   Record Type : Sales Order
 *   Event       : Before Load
 *
 * CONFIGURATION  ← fill in both values before deploying
 * ──────────────────────────────────────────────────────
 *   SUITELET_SCRIPT_ID     — Script ID of deployed SL_CreateVendorPOs.js
 *   SUITELET_DEPLOYMENT_ID — Deployment ID of SL_CreateVendorPOs.js
 *   Both are found at Customization > Scripting > Scripts > [your Suitelet]
 */
define(['N/ui/serverWidget', 'N/url', 'N/search', 'N/log'],
    function (serverWidget, url, search, log) {

        // ══════════════════════════════════════════════════════════════════
        //  CONFIGURATION  ← set after deploying the Suitelet
        // ══════════════════════════════════════════════════════════════════

        var SUITELET_SCRIPT_ID     = 'customscript_crc_sl_create_vendor_pos'; // ← CHANGE THIS
        var SUITELET_DEPLOYMENT_ID = 'customdeploy_crc_sl_create_vendor_pos'; // ← CHANGE THIS

        /** Must match the constant in the Suitelet */
        var CREATED_PO_FIELD = 'custcol_crc_created_po_id';

        // ══════════════════════════════════════════════════════════════════
        //  ENTRY POINT
        // ══════════════════════════════════════════════════════════════════

        function beforeLoad(context) {
            // Only show on existing SOs, not on the create form
            if (context.type === context.UserEventType.CREATE) {
                return;
            }

            try {
                var soId = context.newRecord.id;

                // ── Build Suitelet URL server-side ────────────────────────
                var suiteletUrl = url.resolveScript({
                    scriptId:     SUITELET_SCRIPT_ID,
                    deploymentId: SUITELET_DEPLOYMENT_ID,
                    params:       { soId: soId }
                });

                // ── Inject the button function via INLINEHTML ─────────────
                var scriptField = context.form.addField({
                    id:    'custpage_create_po_script',
                    type:  serverWidget.FieldType.INLINEHTML,
                    label: 'Script'
                });

                scriptField.defaultValue =
                    '<script type="text/javascript">' +
                    'function createVendorPOs() {' +
                    '  window.location.href = "' + suiteletUrl + '";' +
                    '}' +
                    // Move the "Purchase Orders" tab to sit just before the
                    // "System Information" tab in the tab bar.  Searches by
                    // text content so it is resilient to NetSuite DOM changes.
                    // Wrapped in try/catch — silent no-op if the DOM differs.
                    'window.addEventListener("load", function() {' +
                    '  try {' +
                    '    var ourBtn = null, sysBtn = null;' +
                    '    var els = document.querySelectorAll("td, li, [role=tab], a");' +
                    '    for (var i = 0; i < els.length; i++) {' +
                    '      var t = (els[i].textContent || "").trim();' +
                    '      if (!ourBtn && t.indexOf("Purchase Orders") === 0) { ourBtn = els[i]; }' +
                    '      if (!sysBtn  && t === "System Information")         { sysBtn  = els[i]; }' +
                    '      if (ourBtn && sysBtn) break;' +
                    '    }' +
                    '    if (ourBtn && sysBtn && ourBtn.parentNode === sysBtn.parentNode) {' +
                    '      sysBtn.parentNode.insertBefore(ourBtn, sysBtn);' +
                    '    }' +
                    '  } catch(e) {}' +
                    '});' +
                    '</script>';

                // ── Add the button ────────────────────────────────────────
                context.form.addButton({
                    id:           'custpage_create_vendor_pos',
                    label:        'Create Vendor POs',
                    functionName: 'createVendorPOs'
                });

                log.debug('Button Added', 'SO ' + soId + ' — Suitelet URL: ' + suiteletUrl);

                // ── Display linked POs on the form ────────────────────────
                displayLinkedPOs(context);

            } catch (e) {
                log.error('beforeLoad Error', e.toString());
            }
        }

        // ══════════════════════════════════════════════════════════════════
        //  DISPLAY LINKED PURCHASE ORDERS
        // ══════════════════════════════════════════════════════════════════

        /**
         * Renders a "Purchase Orders (N)" tab showing every PO line created
         * from this SO as a styled HTML table: PO Number (link), Vendor, Item,
         * Description, Status.
         *
         * WHY THIS APPROACH
         * ─────────────────
         * SublistType.LIST with tab: on a *transaction* form UE beforeLoad
         * renders the sublist in the main form body, never inside the custom
         * tab — confirmed across multiple attempts.
         * INLINEHTML fields always render in the page header regardless of
         * their container assignment.
         *
         * The solution combines both confirmed-working facts:
         *   1. addFieldGroup({ tab }) DOES render inside the custom tab.
         *   2. INLINEHTML DOES render JavaScript in the page.
         * So we build the HTML table server-side, inject it hidden via
         * INLINEHTML, add a field-group DOM anchor inside the tab, then
         * on page-load JavaScript moves the table into the tab by inserting
         * it before the field-group element and hiding the field group.
         */
        function displayLinkedPOs(context) {
            try {
                var soRec     = context.newRecord;
                var lineCount = soRec.getLineCount({ sublistId: 'item' });

                // ── Collect PO IDs + item/description per SO line ─────────
                var poIdMap  = {};
                var lineData = []; // [{poId, item, description}]

                for (var i = 0; i < lineCount; i++) {
                    var poId = soRec.getSublistValue({
                        sublistId: 'item',
                        fieldId:   CREATED_PO_FIELD,
                        line:      i
                    });
                    if (poId) {
                        var poIdStr = String(poId);
                        poIdMap[poIdStr] = true;
                        lineData.push({
                            poId:        poIdStr,
                            item:        soRec.getSublistText({  sublistId: 'item', fieldId: 'item',        line: i }) || '',
                            description: soRec.getSublistValue({ sublistId: 'item', fieldId: 'description', line: i }) || ''
                        });
                    }
                }

                var poIdList = Object.keys(poIdMap);
                if (poIdList.length === 0) { return; }

                // ── Look up PO header details ─────────────────────────────
                var poResults = search.create({
                    type: search.Type.PURCHASE_ORDER,
                    filters: [
                        ['internalid', 'anyof', poIdList],
                        'AND',
                        ['mainline', 'is', 'T']
                    ],
                    columns: [
                        search.createColumn({ name: 'tranid', sort: search.Sort.ASC }),
                        search.createColumn({ name: 'entity' }),
                        search.createColumn({ name: 'status' })
                    ]
                }).run().getRange({ start: 0, end: poIdList.length + 1 });

                if (!poResults || poResults.length === 0) { return; }

                // Build poId → {poNum, vendor, status} map
                var poDataMap = {};
                poResults.forEach(function (r) {
                    poDataMap[r.id] = {
                        poNum:  r.getValue({ name: 'tranid'  }) || '',
                        vendor: r.getText({  name: 'entity'  }) || '',
                        status: r.getText({  name: 'status'  }) || ''
                    };
                });

                // ── Build styled HTML table ───────────────────────────────
                var esc = function (s) {
                    return String(s || '')
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;');
                };

                var tbl =
                    '<div id="custpage_po_tbl" style="display:none;padding:10px 15px">' +
                    '<table style="width:100%;border-collapse:collapse;' +
                    'font-family:Arial,sans-serif;font-size:13px">' +
                    '<thead><tr style="background:#e8e8e8">' +
                    '<th style="padding:6px 10px;text-align:left;' +
                    'border-bottom:2px solid #bbb;white-space:nowrap">PO Number</th>' +
                    '<th style="padding:6px 10px;text-align:left;border-bottom:2px solid #bbb">Vendor</th>' +
                    '<th style="padding:6px 10px;text-align:left;border-bottom:2px solid #bbb">Item</th>' +
                    '<th style="padding:6px 10px;text-align:left;border-bottom:2px solid #bbb">Description</th>' +
                    '<th style="padding:6px 10px;text-align:left;' +
                    'border-bottom:2px solid #bbb;white-space:nowrap">Status</th>' +
                    '</tr></thead><tbody>';

                lineData.forEach(function (ld, idx) {
                    var pd  = poDataMap[ld.poId] || { poNum: '', vendor: '', status: '' };
                    var bg  = (idx % 2 === 0) ? '#ffffff' : '#f5f5f5';
                    var href = '/app/accounting/transactions/purchord.nl?id=' + ld.poId;
                    tbl +=
                        '<tr style="background:' + bg + ';border-bottom:1px solid #e0e0e0">' +
                        '<td style="padding:5px 10px"><a href="' + href + '">' + esc(pd.poNum) + '</a></td>' +
                        '<td style="padding:5px 10px">' + esc(pd.vendor)       + '</td>' +
                        '<td style="padding:5px 10px">' + esc(ld.item)         + '</td>' +
                        '<td style="padding:5px 10px">' + esc(ld.description)  + '</td>' +
                        '<td style="padding:5px 10px">' + esc(pd.status)       + '</td>' +
                        '</tr>';
                });

                tbl += '</tbody></table></div>';

                // ── JavaScript: move the table from the header into the tab ─
                // Finds the field-group anchor that IS inside the custom tab,
                // inserts the table before it, then hides the field group.
                // Tries getElementById first (exact match), then a substring
                // selector to cover any suffix NetSuite appends to the ID.
                var moveScript =
                    '<script>window.addEventListener("load",function(){' +
                    'try{' +
                    'var t=document.getElementById("custpage_po_tbl");' +
                    'if(!t)return;' +
                    'var fg=document.getElementById("custpage_po_fg")||' +
                    'document.querySelector(\'[id*="custpage_po_fg"]\');' +
                    'if(fg){' +
                    'fg.parentNode.insertBefore(t,fg);' +
                    't.style.display="block";' +
                    'fg.style.display="none";' +
                    '}' +
                    '}catch(e){}' +
                    '});</script>';

                // ── Add tab ───────────────────────────────────────────────
                context.form.addTab({
                    id:    'custpage_po_tab',
                    label: 'Purchase Orders (' + poResults.length + ')'
                });

                // ── Field group: DOM anchor inside the tab ────────────────
                // addFieldGroup with tab: is confirmed to render inside the
                // custom tab. JavaScript will insert the HTML table before
                // this element, then hide the field group.
                context.form.addFieldGroup({
                    id:    'custpage_po_fg',
                    label: 'Purchase Orders',
                    tab:   'custpage_po_tab'
                });

                // A single field makes the field group render in the DOM.
                var fAnchor = context.form.addField({
                    id:        'custpage_po_anchor',
                    type:      serverWidget.FieldType.TEXT,
                    label:     'Loading\u2026',
                    container: 'custpage_po_fg'
                });
                fAnchor.defaultValue = '';
                fAnchor.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });

                // ── Inject table HTML + move script via INLINEHTML ────────
                // INLINEHTML always renders in the page header; the script
                // above relocates it into the tab at page-load time.
                var htmlFld = context.form.addField({
                    id:    'custpage_po_html_data',
                    type:  serverWidget.FieldType.INLINEHTML,
                    label: 'PO Table'
                });
                htmlFld.defaultValue = tbl + moveScript;

                log.debug('displayLinkedPOs', lineData.length + ' row(s) for ' + poResults.length + ' PO(s)');

            } catch (e) {
                log.error('displayLinkedPOs Error', e.toString());
            }
        }

        return { beforeLoad: beforeLoad };
    }
);
