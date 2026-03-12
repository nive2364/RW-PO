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
         * status / amount, then renders a "Purchase Orders" section directly
         * on the SO form.
         *
         * This replaces the native Related Records tab behaviour because
         * NetSuite's Special Order relationship (which drives that tab) cannot
         * be written by record.create() — it is an internal-only pipeline.
         */
        function displayLinkedPOs(context) {
            try {
                var soRec     = context.newRecord;
                var lineCount = soRec.getLineCount({ sublistId: 'item' });

                // Collect unique PO IDs stamped on SO lines
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
                    return; // No linked POs yet — don't add the section
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

                // ── Build HTML table ──────────────────────────────────────
                var html =
                    '<table style="border-collapse:collapse;width:100%;' +
                    'font-family:Arial,sans-serif;font-size:13px;">' +
                    '<thead>' +
                    '<tr style="background:#1F7EC2;color:#fff;">' +
                    '<th style="padding:7px 12px;text-align:left;">PO Number</th>' +
                    '<th style="padding:7px 12px;text-align:left;">Vendor</th>' +
                    '<th style="padding:7px 12px;text-align:left;">Status</th>' +
                    '<th style="padding:7px 12px;text-align:right;">Amount</th>' +
                    '</tr>' +
                    '</thead><tbody>';

                poResults.forEach(function (r, idx) {
                    var bg     = idx % 2 === 0 ? '#f9f9f9' : '#fff';
                    var id     = r.id;
                    var num    = r.getValue({ name: 'tranid'  }) || '—';
                    var vendor = r.getText({  name: 'entity'  }) || '—';
                    var status = r.getText({  name: 'status'  }) || '—';
                    var amt    = r.getValue({ name: 'amount'  }) || '0.00';

                    html +=
                        '<tr style="background:' + bg + ';">' +
                        '<td style="padding:6px 12px;">' +
                        '<a href="/app/accounting/transactions/purchord.nl?id=' + id +
                        '" target="_blank">' + num + '</a></td>' +
                        '<td style="padding:6px 12px;">' + vendor + '</td>' +
                        '<td style="padding:6px 12px;">' + status + '</td>' +
                        '<td style="padding:6px 12px;text-align:right;">' + amt + '</td>' +
                        '</tr>';
                });

                html += '</tbody></table>';

                // ── Inject as a tab next to Related Records ───────────────
                context.form.addTab({
                    id:    'custpage_po_tab',
                    label: 'Purchase Orders (' + poResults.length + ')'
                });

                context.form.addFieldGroup({
                    id:    'custpage_linked_pos_grp',
                    label: ' ',
                    tab:   'custpage_po_tab'
                });

                var htmlField = context.form.addField({
                    id:        'custpage_linked_pos_html',
                    type:      serverWidget.FieldType.INLINEHTML,
                    label:     'POs',
                    container: 'custpage_linked_pos_grp'
                });
                htmlField.defaultValue = html;

                log.debug('Linked POs Displayed', poResults.length + ' PO(s) on SO');

            } catch (e) {
                log.error('displayLinkedPOs Error', e.toString());
            }
        }

        return { beforeLoad: beforeLoad };
    }
);
