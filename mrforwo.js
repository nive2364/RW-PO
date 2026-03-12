/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 */
define(['N/record', 'N/search', 'N/runtime', 'N/log', 'N/format'],
    function(record, search, runtime, log, format) {
    
        function getInputData(context) {
            // Get the Work Order ID from the script parameter
            var workOrderId = runtime.getCurrentScript().getParameter({ name: 'custscript_workorder_id' });
            log.debug('Map/Reduce', 'getInputData started');
            log.debug('Map/Reduce', 'Work Order ID: ' + workOrderId);
            if (!workOrderId) throw 'No Work Order ID provided';
            return [workOrderId];
        }
    
        function map(context) {
            log.debug('Map/Reduce', 'map started for value: ' + context.value);
            var workOrderId = context.value;
            var bomId; // Declare at the top for scope
    
            try {
                // Load the Work Order to get the BOM and BOM Revision
                var wo = record.load({ type: record.Type.WORK_ORDER, id: workOrderId });
                bomId = wo.getValue({ fieldId: 'billofmaterials' });
                log.debug('Map/Reduce', 'Loaded Work Order. BOM ID: ' + bomId);
    
                if (!bomId) {
                    log.error('Map/Reduce', 'No BOM on Work Order: ' + workOrderId);
                    return;
                }
    
                // Find all BOM Revisions for this BOM
                var bomRevSearch = search.create({
                    type: 'bomrevision',
                    filters: [
                        ['billofmaterials', 'anyof', bomId]
                    ],
                    columns: [
                        'internalid',
                        'custrecord_crc_rn_base_rev', // Base checkbox
                        'effectivestartdate',
                        'effectiveenddate'
                    ]
                });
    
                var baseRevisionId = null;
                var revisions = [];
    
                bomRevSearch.run().each(function(result) {
                    var allColumns = result.columns.map(function(col) {
                        return col.name + ': ' + result.getValue(col);
                    }).join(', ');
                    log.debug('Revision All Columns', allColumns);
                    var revId = result.getValue('internalid');
                    var baseRaw = result.getValue('custrecord_crc_rn_base_rev');
                    log.debug('Base Raw Value', 'revId: ' + revId + ', baseRaw: ' + baseRaw);
                    var isBase = baseRaw == '1';
                    var effectiveStartDate = result.getValue('effectivestartdate');
                    var effectiveEndDate = result.getValue('effectiveenddate');
                    revisions.push({
                        id: revId,
                        isBase: isBase,
                        effectiveStartDate: effectiveStartDate,
                        effectiveEndDate: effectiveEndDate
                    });
                    if (isBase) baseRevisionId = revId;
                    return true;
                });
    
                log.debug('Map/Reduce', 'Found revisions: ' + JSON.stringify(revisions));
                if (!baseRevisionId) {
                    log.error('Map/Reduce', 'No base BOM revision found for BOM: ' + bomId + '. Revisions: ' + JSON.stringify(revisions));
                    return;
                }
    
                // Calculate two days ago and yesterday in NetSuite format
                var today = new Date();
                var twoDaysAgo = new Date(today);
                twoDaysAgo.setDate(today.getDate() - 2);
                var nsTwoDaysAgo = format.format({ value: twoDaysAgo, type: format.Type.DATE });
                var yesterday = new Date(today);
                yesterday.setDate(today.getDate() - 1);
                var nsYesterday = format.format({ value: yesterday, type: format.Type.DATE });
    
                // Log all revision dates before changes
                log.audit('Map/Reduce', 'Revision dates before changes: ' + JSON.stringify(revisions));
    
                // Find the most recent non-base, open revision (the one created from the SO)
                var nonBaseOpenRevision = null;
                revisions.forEach(function(rev) {
                    if (!rev.isBase && (!rev.effectiveEndDate || rev.effectiveEndDate === "")) {
                        nonBaseOpenRevision = rev;
                    }
                });

                if (nonBaseOpenRevision) {
                    // Set effective end date to match its effective start date
                    record.submitFields({
                        type: 'bomrevision',
                        id: nonBaseOpenRevision.id,
                        values: { effectiveenddate: nonBaseOpenRevision.effectiveStartDate }
                    });
                    log.audit('Map/Reduce', 'Set effective end date on non-base revision: ' + nonBaseOpenRevision.id + ' to its start date ' + nonBaseOpenRevision.effectiveStartDate);
                }

                // Set the base BOM revision's effective start date to three days ago and clear its end date
                var threeDaysAgo = new Date(today);
                threeDaysAgo.setDate(today.getDate() - 3);
                var nsThreeDaysAgo = format.format({ value: threeDaysAgo, type: format.Type.DATE });
                revisions.forEach(function(rev) {
                    if (rev.isBase) {
                        record.submitFields({
                            type: 'bomrevision',
                            id: rev.id,
                            values: { effectiveenddate: '', effectivestartdate: nsThreeDaysAgo }
                        });
                        log.audit('Map/Reduce', 'Cleared effective end date and set effective start date to three days ago on base revision: ' + rev.id);
                    }
                });
    
                // Reload and log all revision dates after changes
                var afterRevisions = [];
                bomRevSearch.run().each(function(result) {
                    afterRevisions.push({
                        id: result.getValue('internalid'),
                        isBase: result.getValue('custrecord_crc_rn_base_rev') == '1',
                        effectiveStartDate: result.getValue('effectivestartdate'),
                        effectiveEndDate: result.getValue('effectiveenddate')
                    });
                    return true;
                });
                log.audit('Map/Reduce', 'Revision dates after changes: ' + JSON.stringify(afterRevisions));
    
                log.audit('Map/Reduce', 'map completed for Work Order: ' + workOrderId);
    
            } catch (e) {
                log.error('Map/Reduce', 'Error in map for Work Order: ' + workOrderId + ' - ' + e.message + (typeof bomId !== 'undefined' ? (' BOM ID: ' + bomId) : ''), e);
            }
        }
    
        function summarize(summary) {
            log.audit('Map/Reduce', 'Summarize phase started');
            if (summary.inputSummary.error) {
                log.error('Map/Reduce', 'Input Error: ' + summary.inputSummary.error);
            }
            summary.mapSummary.errors.iterator().each(function(key, error) {
                log.error('Map/Reduce', 'Map Error for key: ' + key + ' - ' + error);
                return true;
            });
            log.audit('Map/Reduce', 'Summarize phase completed');
        }
    
        return {
            getInputData: getInputData,
            map: map,
            summarize: summarize
        };
    });