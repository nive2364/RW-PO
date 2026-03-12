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
         * status / amount, then renders a "Purchase Orders (N)" tab in the
         * SO form tab bar next to Related Records.
         *
         * Uses SublistType.LIST — NOT INLINEHTML. INLINEHTML in a UE
         * beforeLoad always renders into the page header regardless of any
         * container or tab assignment; it cannot be placed inside a tab.
         * A LIST sublist respects the tab parameter and renders correctly
         * inside the tab body.
         *
         * The "Open" URL column uses linkText so every row shows the word
         * "Open" as a clickable link to its specific PO.
         */
        function displayLinkedPOs(context) {
            try {
                var soRec     = context.newRecord;
                var lineCount = soRec.getLineCount({ sublistId: 'item' });

                // ── Collect unique PO IDs stamped on SO lines ─────────────
                var poIdMap = {};
                for (var i = 0; i < lineCount; i++) {
                    var poId = soRec.getSublistValue({
                        sublistId: 'item',
                        fieldId:   CREATED_PO_FIELD,
                        line:      i
                    });
                    if (poId) {
                        poIdMap[String(poId)] = true;
                    }
                }

                var poIdList = Object.keys(poIdMap);
                if (poIdList.length === 0) {
                    return; // No linked POs yet — don't add the tab
                }

                // ── Look up PO details ────────────────────────────────────
                var poResults = search.create({
                    type: search.Type.PURCHASE_ORDER,
                    filters: [
                        ['internalid', 'anyof', poIdList],
                        'AND',
                        ['mainline', 'is', 'T']
                    ],
                    columns: [
                        search.createColumn({ name: 'tranid',  sort: search.Sort.ASC }),
                        search.createColumn({ name: 'entity' }),
                        search.createColumn({ name: 'status' }),
                        search.createColumn({ name: 'amount' })
                    ]
                }).run().getRange({ start: 0, end: poIdList.length + 1 });

                if (!poResults || poResults.length === 0) {
                    return;
                }

                // ── Add tab to the SO tab bar ─────────────────────────────
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

                sublist.addColumn({ id: 'custpage_po_num',    type: serverWidget.FieldType.TEXT, label: 'PO Number' });
                sublist.addColumn({ id: 'custpage_po_vendor', type: serverWidget.FieldType.TEXT, label: 'Vendor'    });
                sublist.addColumn({ id: 'custpage_po_status', type: serverWidget.FieldType.TEXT, label: 'Status'    });
                sublist.addColumn({ id: 'custpage_po_amount', type: serverWidget.FieldType.TEXT, label: 'Amount'    });

                // URL column: linkText sets the display text for all rows
                // so each cell shows "Open" as a clickable link to that PO
                var openCol = sublist.addColumn({
                    id:    'custpage_po_open',
                    type:  serverWidget.FieldType.URL,
                    label: 'View PO'
                });
                openCol.linkText = 'Open';

                // ── Populate one row per PO ───────────────────────────────
                // Each row is wrapped in its own try/catch + debug log so
                // any field-level failure surfaces in the execution log
                // instead of silently swallowing the rest of the rows.
                poResults.forEach(function (r, idx) {
                    try {
                        var poNum  = r.getValue({ name: 'tranid'  }) || '';
                        var vendor = r.getText({  name: 'entity'  }) || '';
                        var status = r.getText({  name: 'status'  }) || '';
                        var rawAmt = r.getValue({ name: 'amount'  });
                        var amount = rawAmt ? parseFloat(rawAmt).toFixed(2) : '0.00';

                        sublist.setSublistValue({ id: 'custpage_po_num',    line: idx, value: poNum   });
                        sublist.setSublistValue({ id: 'custpage_po_vendor', line: idx, value: vendor  });
                        sublist.setSublistValue({ id: 'custpage_po_status', line: idx, value: status  });
                        sublist.setSublistValue({ id: 'custpage_po_amount', line: idx, value: amount  });
                        sublist.setSublistValue({ id: 'custpage_po_open',   line: idx, value: '/app/accounting/transactions/purchord.nl?id=' + r.id });

                        log.debug('PO Row ' + idx, 'PO: ' + poNum + ' | Vendor: ' + vendor + ' | Status: ' + status + ' | Amt: ' + amount);
                    } catch (rowErr) {
                        log.error('PO Row ' + idx + ' Error', rowErr.toString());
                    }
                });

                log.debug('Linked POs Tab Added', poResults.length + ' PO(s) on SO');

            } catch (e) {
                log.error('displayLinkedPOs Error', e.toString());
            }
        }

        return { beforeLoad: beforeLoad };
    }
);
