/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * @Author: Randy Nivert CanyonRim Consulting
 *
 * PURPOSE
 * ───────
 * Called by the "Create Vendor POs" button on the Sales Order.
 * Groups all eligible SO lines by vendor, creates one PO per vendor,
 * links each PO back to the SO, then shows a results page.
 *
 * FOUR KEY BEHAVIORS
 * ──────────────────
 * 1. DUPLICATE PREVENTION
 *    A custom Transaction Line Field (custcol_crc_created_po_id) stores the
 *    internal ID of the PO created for each SO line. On each run the script
 *    checks this field — if populated, the line is skipped. This is reliable
 *    because we write it ourselves and it is not system-protected.
 *    Field to create: Setup > Customization > Transaction Line Fields > New
 *      Label:    Created PO ID
 *      ID:       custcol_crc_created_po_id   (← must match CREATED_PO_FIELD below)
 *      Type:     Integer  (stores the PO internal ID as a number)
 *      Applies:  Sales Order
 *      Display:  Hidden (employees don't need to see it)
 *
 * 2. SO LINE LINK (shows PO number where "Drop Ship Spec. Ord." was)
 *    After creating each PO, the script writes the PO internal ID to
 *    custcol_crc_created_po_id on the SO line, then uses a separate
 *    afterSubmit UE on the PO (UE_PO_LinkToSO.js) to handle the native
 *    createdpo population via a supported path.
 *    NOTE: NetSuite's createdpo field is fully system-managed and cannot
 *    be written by any script. The PO number will display via a custom
 *    inline field on the SO line instead — see UE_SO_CreateVendorPOs.js
 *    for how to add that display field.
 *
 * 3. RELATED RECORDS TAB
 *    The SO's Related Records tab is driven by line-level linking, not just
 *    the PO body's createdfrom field. Each PO line must have:
 *      ordertransaction = SO internal ID  (integer, not string)
 *      orderline        = SO line number  (the 'line' field value on the SO)
 *    These replicate exactly what NetSuite's native Spec. Ord. button writes.
 *    createdfrom on the PO header is also set (parseInt) for completeness.
 *    Note: record.transform() from SO → PO is not a supported transformation.
 *
 * 4. RETURN TO SO BUTTON
 *    The result page injects a <script> tag (same technique as the main
 *    button) so the "Return to Sales Order" navigation works correctly.
 *
 * ELIGIBILITY RULES (per SO line)
 * ────────────────────────────────
 *   SKIP  — custcol_crc_created_po_id is populated (already has a PO)
 *   SKIP  — line is fully fulfilled
 *   WARN  — line has no vendor (no PO created, shown on results page)
 *   GROUP — remaining lines grouped by vendor → one PO each
 *
 * PO NAMING
 * ─────────
 *   First PO  → SO17001-Blair
 *   Second PO → SO17001-Blair-1
 *   Third PO  → SO17001-Blair-2  …etc.
 *
 * PREREQUISITES
 * ─────────────
 *   Create BOTH custom fields before deploying:
 *   Setup > Customization > Transaction Line Fields > New
 *
 *   Field 1 — duplicate prevention (hidden from users):
 *       Label:   Created PO ID
 *       ID:      custcol_crc_created_po_id
 *       Type:    Integer
 *       Applies: Sales Order
 *       Display: Hidden
 *
 *   Field 2 — visible PO number on the SO line:
 *       Label:   Created PO Number
 *       ID:      custcol_crc_created_po_num
 *       Type:    Free-Form Text
 *       Applies: Sales Order
 *       Display: Normal (show on Items sublist)
 *
 * DEPLOYMENT
 * ──────────
 *   Record Type : (none — Suitelet)
 *   Access      : Internal users only
 */
define(['N/record', 'N/search', 'N/ui/serverWidget', 'N/log'],
    function (record, search, serverWidget, log) {

        // ══════════════════════════════════════════════════════════════════
        //  CONFIGURATION
        // ══════════════════════════════════════════════════════════════════

        /** Vendor column on the SO item sublist — confirmed via Field Explorer */
        var SO_LINE_VENDOR_FIELD = 'custcol_crc_itm_vend';

        /**
         * Custom line field that stores the PO internal ID created for each
         * SO line. Used for duplicate prevention only — hidden from users.
         * Must be created before deploying — see PREREQUISITES in the header.
         */
        var CREATED_PO_FIELD = 'custcol_crc_created_po_id';

        /**
         * Custom line field that displays the PO number (e.g. SO17001-Blair)
         * on the SO line so users can see which PO was created for each line.
         * Type: Free-Form Text, visible. See PREREQUISITES in the header.
         */
        var CREATED_PO_NUMBER_FIELD = 'custcol_crc_created_po_num';

        // ══════════════════════════════════════════════════════════════════
        //  ENTRY POINT
        // ══════════════════════════════════════════════════════════════════

        function onRequest(context) {
            var soId = context.request.parameters.soId;

            if (!soId) {
                renderError(context, 'No Sales Order ID was provided.');
                return;
            }

            try {
                var result = createVendorPOsForSO(soId);
                renderResultPage(context, soId, result);
            } catch (e) {
                log.error('onRequest Fatal', e.toString() + (e.stack ? '\n' + e.stack : ''));
                renderError(context, 'Unexpected error: ' + e.toString());
            }
        }

        // ══════════════════════════════════════════════════════════════════
        //  CORE: read SO, group lines, create POs
        // ══════════════════════════════════════════════════════════════════

        function createVendorPOsForSO(soId) {
            var result = {
                soNumber:      '',
                posCreated:    [],
                skippedLines:  [],
                noVendorLines: [],
                errors:        []
            };

            // ── Load Sales Order ──────────────────────────────────────────
            var soRecord = record.load({
                type:      record.Type.SALES_ORDER,
                id:        soId,
                isDynamic: false
            });

            var soNumber   = soRecord.getValue({ fieldId: 'tranid' });
            var customerId = soRecord.getValue({ fieldId: 'entity' });
            result.soNumber = soNumber;

            if (!soNumber || !customerId) {
                throw new Error('Could not read SO number or customer from SO ' + soId);
            }

            var customerLastName = getCustomerLastName(customerId);
            if (!customerLastName) {
                throw new Error('Could not resolve customer last name for customer ' + customerId);
            }

            var basePONumber = soNumber + '-' + customerLastName;
            var headerValues = captureSOHeaderValues(soRecord);

            // ── Walk SO lines and classify ────────────────────────────────
            var soLineCount  = soRecord.getLineCount({ sublistId: 'item' });
            var vendorGroups = {};
            var vendorOrder  = [];

            for (var i = 0; i < soLineCount; i++) {
                var itemType    = soRecord.getSublistValue({ sublistId: 'item', fieldId: 'itemtype',  line: i });
                var itemId      = soRecord.getSublistValue({ sublistId: 'item', fieldId: 'item',      line: i });
                var displayName = soRecord.getSublistText({  sublistId: 'item', fieldId: 'item',      line: i });
                var quantity    = parseFloat(soRecord.getSublistValue({ sublistId: 'item', fieldId: 'quantity',          line: i })) || 0;
                var qtyFulfilled= parseFloat(soRecord.getSublistValue({ sublistId: 'item', fieldId: 'quantityfulfilled', line: i })) || 0;
                var soLineNum   = soRecord.getSublistValue({ sublistId: 'item', fieldId: 'line',      line: i });

                // Skip structural lines
                if (!itemId || itemType === 'Subtotal' || itemType === 'EndGroup' || itemType === 'Group') {
                    continue;
                }

                // ── SKIP: already has a PO (our custom field) ─────────────
                var existingPoId = null;
                try {
                    existingPoId = soRecord.getSublistValue({
                        sublistId: 'item', fieldId: CREATED_PO_FIELD, line: i
                    });
                } catch(e) {
                    log.error('CREATED_PO_FIELD read error',
                        'Field "' + CREATED_PO_FIELD + '" not found. Check Prerequisites. ' + e.toString());
                }
                if (existingPoId) {
                    result.skippedLines.push({ item: displayName, reason: 'PO already created (PO ID: ' + existingPoId + ')' });
                    log.debug('Skipped (has PO)', 'Line ' + i + ': ' + displayName);
                    continue;
                }

                // ── SKIP: fully fulfilled ─────────────────────────────────
                if (quantity > 0 && qtyFulfilled >= quantity) {
                    result.skippedLines.push({ item: displayName, reason: 'Fully fulfilled' });
                    continue;
                }

                // ── Read vendor ───────────────────────────────────────────
                var vendorId   = null;
                var vendorName = '(no vendor)';
                try {
                    vendorId   = soRecord.getSublistValue({ sublistId: 'item', fieldId: SO_LINE_VENDOR_FIELD, line: i });
                    vendorName = soRecord.getSublistText({  sublistId: 'item', fieldId: SO_LINE_VENDOR_FIELD, line: i }) || '(no vendor)';
                } catch (e) {
                    log.error('Vendor Read Error', 'Line ' + i + ': ' + e.toString());
                }

                if (!vendorId) {
                    result.noVendorLines.push({ item: displayName });
                    continue;
                }

                // ── Collect line data ─────────────────────────────────────
                var openQty  = quantity - qtyFulfilled;
                var lineData = {
                    soIndex:     i,
                    soLineNum:   soLineNum,
                    itemId:      itemId,
                    displayName: displayName,
                    quantity:    openQty,
                    rate:        soRecord.getSublistValue({ sublistId: 'item', fieldId: 'rate',       line: i }),
                    description: getSOLineDescription(soRecord, i),
                    location:    soRecord.getSublistValue({ sublistId: 'item', fieldId: 'location',   line: i }),
                    department:  soRecord.getSublistValue({ sublistId: 'item', fieldId: 'department', line: i }),
                    class_:      soRecord.getSublistValue({ sublistId: 'item', fieldId: 'class',      line: i })
                };

                var groupKey = String(vendorId);
                if (!vendorGroups[groupKey]) {
                    vendorGroups[groupKey] = { vendorId: vendorId, vendorName: vendorName, lines: [] };
                    vendorOrder.push(groupKey);
                }
                vendorGroups[groupKey].lines.push(lineData);
            }

            log.debug('Groups Built',
                vendorOrder.length + ' group(s): ' +
                vendorOrder.map(function(k) { return vendorGroups[k].vendorName; }).join(', '));

            // ── Create one PO per vendor group ────────────────────────────
            vendorOrder.forEach(function (groupKey) {
                var group        = vendorGroups[groupKey];
                var existingCount= countExistingPOs(basePONumber);
                var poNumber     = assignPONumber(basePONumber, existingCount);

                log.debug('Creating PO', 'Vendor: ' + group.vendorName + ', Number: ' + poNumber);

                var newPoId = createVendorPO(group.vendorId, poNumber, group.lines, headerValues, soId);

                if (newPoId) {
                    // ── Stamp custom fields on SO lines (ID for duplicate
                    //    prevention, number for display)
                    stampSOLines(soId, group.lines, newPoId, poNumber);

                    result.posCreated.push({
                        poId:       newPoId,
                        poNumber:   poNumber,
                        vendorName: group.vendorName,
                        lineCount:  group.lines.length
                    });
                    log.audit('PO Created', 'ID: ' + newPoId + ', Number: ' + poNumber + ', Vendor: ' + group.vendorName);
                } else {
                    result.errors.push({ vendorName: group.vendorName });
                }
            });

            return result;
        }

        // ══════════════════════════════════════════════════════════════════
        //  CREATE A SINGLE VENDOR PO
        // ══════════════════════════════════════════════════════════════════

        function createVendorPO(vendorId, poNumber, lines, headerValues, soId) {
            try {
                // record.create() with createdfrom = SO internal ID is the
                // correct SuiteScript path for Special Order POs. NetSuite
                // recognises createdfrom pointing to an SO and displays the PO
                // on the SO's Related Records tab automatically.
                //
                // IMPORTANT: soId arrives as a URL parameter string. createdfrom
                // is an integer field — passing a string silently fails to link
                // the records. parseInt() is required.
                //
                // Note: record.transform() from SO → PO is NOT a supported
                // NetSuite transformation type (INVALID_RCRD_TRANSFRM error).
                var newPO = record.create({
                    type:      record.Type.PURCHASE_ORDER,
                    isDynamic: true
                });

                newPO.setValue({ fieldId: 'createdfrom', value: parseInt(soId, 10) });
                newPO.setValue({ fieldId: 'entity',      value: vendorId });
                newPO.setValue({ fieldId: 'tranid',      value: poNumber });

                Object.keys(headerValues).forEach(function (fld) {
                    var val = headerValues[fld];
                    if (val !== null && val !== undefined && val !== '') {
                        try { newPO.setValue({ fieldId: fld, value: val }); } catch (e) {}
                    }
                });

                // Dynamic mode: set description AFTER item so SO line
                // description overrides the item-record default.
                // ordertransaction + orderline replicate the line-level link
                // that NetSuite's native Spec. Ord. button creates — this is
                // what drives the PO appearing on the SO's Related Records tab.
                lines.forEach(function (ld) {
                    newPO.selectNewLine({ sublistId: 'item' });
                    newPO.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item',             value: ld.itemId });
                    newPO.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity',         value: ld.quantity });
                    newPO.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate',             value: ld.rate });
                    newPO.setCurrentSublistValue({ sublistId: 'item', fieldId: 'description',      value: ld.description });
                    // Line-level SO link — mirrors what Spec. Ord. sets natively
                    try { newPO.setCurrentSublistValue({ sublistId: 'item', fieldId: 'ordertransaction', value: parseInt(soId, 10) }); } catch(e) {}
                    try { newPO.setCurrentSublistValue({ sublistId: 'item', fieldId: 'orderline',        value: ld.soLineNum       }); } catch(e) {}
                    if (ld.location)   { try { newPO.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location',   value: ld.location   }); } catch(e){} }
                    if (ld.department) { try { newPO.setCurrentSublistValue({ sublistId: 'item', fieldId: 'department', value: ld.department }); } catch(e){} }
                    if (ld.class_)     { try { newPO.setCurrentSublistValue({ sublistId: 'item', fieldId: 'class',      value: ld.class_     }); } catch(e){} }
                    newPO.commitLine({ sublistId: 'item' });
                });

                return newPO.save({ ignoreMandatoryFields: true });

            } catch (e) {
                log.error('createVendorPO Failed',
                    'Vendor: ' + vendorId + ', Number: ' + poNumber + ' — ' + e.toString());
                return null;
            }
        }

        // ══════════════════════════════════════════════════════════════════
        //  STAMP PO ID ON SO LINES
        // ══════════════════════════════════════════════════════════════════

        /**
         * Writes two fields on each originating SO line:
         *   custcol_crc_created_po_id  — PO internal ID (Integer, hidden)
         *                                Used for duplicate prevention on re-runs.
         *   custcol_crc_created_po_num — PO number string (Text, visible)
         *                                Displays the PO name on the SO line
         *                                (e.g. "SO17001-Blair") so users can see
         *                                which PO was created for each line.
         *
         * Uses soIndex (the line's array position when we read it) for
         * fast, exact matching — no item-ID ambiguity.
         */
        function stampSOLines(soId, lines, poId, poNumber) {
            try {
                var soRec = record.load({
                    type:      record.Type.SALES_ORDER,
                    id:        soId,
                    isDynamic: true
                });

                lines.forEach(function (ld) {
                    soRec.selectLine({ sublistId: 'item', line: ld.soIndex });
                    soRec.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId:   CREATED_PO_FIELD,
                        value:     poId
                    });
                    soRec.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId:   CREATED_PO_NUMBER_FIELD,
                        value:     poNumber
                    });
                    soRec.commitLine({ sublistId: 'item' });
                });

                soRec.save({ ignoreMandatoryFields: true });
                log.audit('SO Lines Stamped',
                    lines.length + ' line(s) → PO ' + poId + ' (' + poNumber + ')');

            } catch (e) {
                log.error('stampSOLines Failed', 'PO: ' + poId + ' — ' + e.toString());
            }
        }

        // ══════════════════════════════════════════════════════════════════
        //  RESULT PAGE
        // ══════════════════════════════════════════════════════════════════

        function renderResultPage(context, soId, result) {
            var form = serverWidget.createForm({ title: 'Create Vendor POs — ' + result.soNumber });

            // ── Return to SO button ───────────────────────────────────────
            // Must use an injected <script> tag — addButton functionName
            // requires a named window function, same as the main button.
            var navField = form.addField({
                id:    'custpage_nav_script',
                type:  serverWidget.FieldType.INLINEHTML,
                label: 'Nav'
            });
            navField.defaultValue =
                '<script type="text/javascript">' +
                'function returnToSO() {' +
                '  window.location.href = "/app/accounting/transactions/salesord.nl?id=' + soId + '";' +
                '}' +
                '</script>';

            form.addButton({
                id:           'custpage_back_to_so',
                label:        'Return to Sales Order',
                functionName: 'returnToSO'
            });

            // ── POs Created ───────────────────────────────────────────────
            form.addFieldGroup({ id: 'custpage_created', label: result.posCreated.length + ' Purchase Order(s) Created' });

            if (result.posCreated.length > 0) {
                var html = '<table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px;">' +
                    '<thead><tr style="background:#1F7EC2;color:#fff;">' +
                    '<th style="padding:8px 12px;text-align:left;">PO Number</th>' +
                    '<th style="padding:8px 12px;text-align:left;">Vendor</th>' +
                    '<th style="padding:8px 12px;text-align:center;">Lines</th>' +
                    '<th style="padding:8px 12px;text-align:left;">Link</th>' +
                    '</tr></thead><tbody>';
                result.posCreated.forEach(function (po, idx) {
                    html += '<tr style="background:' + (idx % 2 === 0 ? '#f9f9f9' : '#fff') + ';">' +
                        '<td style="padding:7px 12px;">' + po.poNumber + '</td>' +
                        '<td style="padding:7px 12px;">' + po.vendorName + '</td>' +
                        '<td style="padding:7px 12px;text-align:center;">' + po.lineCount + '</td>' +
                        '<td style="padding:7px 12px;"><a href="/app/accounting/transactions/purchord.nl?id=' + po.poId + '" target="_blank">View PO</a></td>' +
                        '</tr>';
                });
                html += '</tbody></table>';
                var f = form.addField({ id: 'custpage_created_html', type: serverWidget.FieldType.INLINEHTML, label: 'POs', container: 'custpage_created' });
                f.defaultValue = html;
            } else {
                var nf = form.addField({ id: 'custpage_no_pos', type: serverWidget.FieldType.INLINEHTML, label: 'Result', container: 'custpage_created' });
                nf.defaultValue = '<p style="color:#888;font-family:Arial;font-size:13px;">No POs were created.</p>';
            }

            // ── No Vendor Warnings ────────────────────────────────────────
            if (result.noVendorLines.length > 0) {
                form.addFieldGroup({ id: 'custpage_warnings', label: result.noVendorLines.length + ' Line(s) Skipped — No Vendor Assigned' });
                var wHtml = '<p style="color:#b05c00;font-family:Arial;font-size:13px;margin-bottom:8px;">' +
                    'These lines have no vendor set. Assign a vendor on the SO and run again.</p>' +
                    '<ul style="font-family:Arial;font-size:13px;margin:0;padding-left:20px;">';
                result.noVendorLines.forEach(function (l) { wHtml += '<li>' + l.item + '</li>'; });
                wHtml += '</ul>';
                var wf = form.addField({ id: 'custpage_warn_html', type: serverWidget.FieldType.INLINEHTML, label: 'Warnings', container: 'custpage_warnings' });
                wf.defaultValue = wHtml;
            }

            // ── Skipped Lines ─────────────────────────────────────────────
            if (result.skippedLines.length > 0) {
                form.addFieldGroup({ id: 'custpage_skipped', label: result.skippedLines.length + ' Line(s) Skipped' });
                var sHtml = '<table style="border-collapse:collapse;width:100%;font-family:Arial;font-size:13px;">' +
                    '<thead><tr style="background:#ddd;"><th style="padding:6px 12px;text-align:left;">Item</th>' +
                    '<th style="padding:6px 12px;text-align:left;">Reason</th></tr></thead><tbody>';
                result.skippedLines.forEach(function (l, idx) {
                    sHtml += '<tr style="background:' + (idx % 2 === 0 ? '#f9f9f9' : '#fff') + ';">' +
                        '<td style="padding:6px 12px;">' + l.item + '</td>' +
                        '<td style="padding:6px 12px;">' + l.reason + '</td></tr>';
                });
                sHtml += '</tbody></table>';
                var sf = form.addField({ id: 'custpage_skip_html', type: serverWidget.FieldType.INLINEHTML, label: 'Skipped', container: 'custpage_skipped' });
                sf.defaultValue = sHtml;
            }

            // ── Errors ────────────────────────────────────────────────────
            if (result.errors.length > 0) {
                form.addFieldGroup({ id: 'custpage_errors', label: result.errors.length + ' Error(s)' });
                var eHtml = '<ul style="font-family:Arial;font-size:13px;color:#c00;margin:0;padding-left:20px;">';
                result.errors.forEach(function (e) { eHtml += '<li>' + e.vendorName + ': PO creation failed — check script execution log.</li>'; });
                eHtml += '</ul>';
                var ef = form.addField({ id: 'custpage_err_html', type: serverWidget.FieldType.INLINEHTML, label: 'Errors', container: 'custpage_errors' });
                ef.defaultValue = eHtml;
            }

            context.response.writePage(form);
        }

        function renderError(context, message) {
            var form  = serverWidget.createForm({ title: 'Create Vendor POs — Error' });
            var field = form.addField({ id: 'custpage_err', type: serverWidget.FieldType.INLINEHTML, label: 'Error' });
            field.defaultValue = '<p style="color:#c00;font-family:Arial;font-size:14px;">' + message + '</p>';
            context.response.writePage(form);
        }

        // ══════════════════════════════════════════════════════════════════
        //  HELPERS
        // ══════════════════════════════════════════════════════════════════

        function assignPONumber(base, existingCount) {
            return existingCount === 0 ? base : base + '-' + existingCount;
        }

        function countExistingPOs(basePONumber) {
            try {
                return search.create({
                    type: search.Type.PURCHASE_ORDER,
                    filters: [['tranid', 'startswith', basePONumber], 'AND', ['mainline', 'is', 'T']],
                    columns: ['tranid']
                }).runPaged().count;
            } catch (e) {
                log.error('countExistingPOs Failed', e.toString());
                return 0;
            }
        }

        function captureSOHeaderValues(soRecord) {
            var values = {};
            ['subsidiary', 'location', 'department', 'class', 'currency',
             'exchangerate', 'terms', 'memo', 'shipaddress', 'shipmethod', 'fob'
            ].forEach(function (fld) {
                try { values[fld] = soRecord.getValue({ fieldId: fld }); } catch (e) {}
            });
            return values;
        }

        function getSOLineDescription(soRecord, lineIndex) {
            try {
                var desc = soRecord.getSublistValue({ sublistId: 'item', fieldId: 'description', line: lineIndex });
                if (!desc || desc === '') {
                    desc = soRecord.getSublistText({ sublistId: 'item', fieldId: 'description', line: lineIndex });
                }
                return desc || '';
            } catch (e) { return ''; }
        }

        function getCustomerLastName(customerId) {
            try {
                var lookup = search.lookupFields({ type: search.Type.CUSTOMER, id: customerId, columns: ['lastname', 'companyname'] });
                return lookup.lastname || lookup.companyname || null;
            } catch (e) {
                log.error('getCustomerLastName Failed', e.toString());
                return null;
            }
        }

        // ══════════════════════════════════════════════════════════════════
        //  EXPORTS
        // ══════════════════════════════════════════════════════════════════

        return { onRequest: onRequest };
    }
);