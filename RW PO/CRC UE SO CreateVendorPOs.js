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
define(['N/ui/serverWidget', 'N/url', 'N/log'],
    function (serverWidget, url, log) {

        // ══════════════════════════════════════════════════════════════════
        //  CONFIGURATION  ← set after deploying the Suitelet
        // ══════════════════════════════════════════════════════════════════

        var SUITELET_SCRIPT_ID     = 'customscript_crc_sl_create_vendor_pos'; // ← CHANGE THIS
        var SUITELET_DEPLOYMENT_ID = 'customdeploy_crc_sl_create_vendor_pos'; // ← CHANGE THIS

        // ══════════════════════════════════════════════════════════════════
        //  ENTRY POINT
        // ══════════════════════════════════════════════════════════════════

        function beforeLoad(context) {
            // Only show button on existing SOs, not on the create form
            if (context.type === context.UserEventType.CREATE) {
                return;
            }

            try {
                var soId = context.newRecord.id;

                // ── Build Suitelet URL server-side ────────────────────────
                // url.resolveScript() is only available server-side, so we
                // build the full URL here and embed it directly in the script tag.
                var suiteletUrl = url.resolveScript({
                    scriptId:     SUITELET_SCRIPT_ID,
                    deploymentId: SUITELET_DEPLOYMENT_ID,
                    params:       { soId: soId }
                });

                // ── Inject the button function via INLINEHTML ─────────────
                // A <script> tag inside an INLINEHTML field is rendered
                // directly into the page — the function is available on
                // window immediately, with no Client Script timing issues.
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

            } catch (e) {
                log.error('beforeLoad Error', e.toString());
            }
        }

        return { beforeLoad: beforeLoad };
    }
);