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
         * Reads custcol_crc_created_po_id from every SO item line, collects
         * the unique PO internal IDs, looks up each PO's number / vendor /
         * status, then renders a "Purchase Orders (N)" tab with a LIST sublist
         * showing one row per SO item line: PO Number, Vendor, Item, Description,
         * Status, and an "Open PO" link.
         *
         * The URL column is wrapped in its own try/catch — it was the original
         * crash point that aborted the forEach in earlier builds.  If it fails
         * the five text columns still display correctly.
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
                            item:        soRec.getSublistText({ sublistId: 'item', fieldId: 'item',        line: i }) || '',
                            description: soRec.getSublistValue({ sublistId: 'item', fieldId: 'description', line: i }) || ''
                        });
                    }
                }

                var poIdList = Object.keys(poIdMap);
                if (poIdList.length === 0) {
                    return; // No linked POs yet — don't add the tab
                }

                // ── Look up PO header details (number / vendor / status) ──
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

                if (!poResults || poResults.length === 0) {
                    return;
                }

                // Build poId → {poNum, vendor, status} lookup map
                var poDataMap = {};
                poResults.forEach(function (r) {
                    poDataMap[r.id] = {
                        poNum:  r.getValue({ name: 'tranid'  }) || '',
                        vendor: r.getText({  name: 'entity'  }) || '',
                        status: r.getText({  name: 'status'  }) || ''
                    };
                });

                // ── Add tab ───────────────────────────────────────────────
                context.form.addTab({
                    id:    'custpage_po_tab',
                    label: 'Purchase Orders (' + poResults.length + ')'
                });

                // ── Add LIST sublist inside the tab ───────────────────────
                var sublist = context.form.addSublist({
                    id:    'custpage_pos_list',
                    type:  serverWidget.SublistType.LIST,
                    label: 'Purchase Orders',
                    tab:   'custpage_po_tab'
                });

                sublist.addColumn({ id: 'custpage_po_num',  type: serverWidget.FieldType.TEXT, label: 'PO Number'   });
                sublist.addColumn({ id: 'custpage_po_vend', type: serverWidget.FieldType.TEXT, label: 'Vendor'      });
                sublist.addColumn({ id: 'custpage_po_item', type: serverWidget.FieldType.TEXT, label: 'Item'        });
                sublist.addColumn({ id: 'custpage_po_desc', type: serverWidget.FieldType.TEXT, label: 'Description' });
                sublist.addColumn({ id: 'custpage_po_stat', type: serverWidget.FieldType.TEXT, label: 'Status'      });

                // URL column: wrapped separately so a failure here does not
                // abort the forEach that populates the five text columns.
                var hasUrlCol = false;
                try {
                    var openCol = sublist.addColumn({
                        id:    'custpage_po_open',
                        type:  serverWidget.FieldType.URL,
                        label: 'View PO'
                    });
                    openCol.linkText = 'Open PO';
                    hasUrlCol = true;
                } catch (urlErr) {
                    log.error('URL Column Add Error', urlErr.toString());
                }

                // ── Populate one row per SO item line ─────────────────────
                lineData.forEach(function (ld, idx) {
                    try {
                        var pd = poDataMap[ld.poId] || { poNum: '', vendor: '', status: '' };

                        sublist.setSublistValue({ id: 'custpage_po_num',  line: idx, value: pd.poNum       });
                        sublist.setSublistValue({ id: 'custpage_po_vend', line: idx, value: pd.vendor       });
                        sublist.setSublistValue({ id: 'custpage_po_item', line: idx, value: ld.item         });
                        sublist.setSublistValue({ id: 'custpage_po_desc', line: idx, value: ld.description  });
                        sublist.setSublistValue({ id: 'custpage_po_stat', line: idx, value: pd.status       });

                        if (hasUrlCol) {
                            sublist.setSublistValue({
                                id:    'custpage_po_open',
                                line:  idx,
                                value: '/app/accounting/transactions/purchord.nl?id=' + ld.poId
                            });
                        }

                        log.debug('PO Row ' + idx, pd.poNum + ' | ' + pd.vendor + ' | ' + ld.item + ' | ' + pd.status);
                    } catch (rowErr) {
                        log.error('PO Row ' + idx + ' Error', rowErr.toString());
                    }
                });

                log.debug('displayLinkedPOs', lineData.length + ' row(s) in Purchase Orders tab');

            } catch (e) {
                log.error('displayLinkedPOs Error', e.toString());
            }
        }

        return { beforeLoad: beforeLoad };
    }
);
