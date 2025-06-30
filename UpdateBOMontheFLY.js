/**
 * @NApiVersion 2.x
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/search', 'N/log', 'N/task'], function(record, search, log, task) {

    function afterSubmit(context) {
        var salesOrder = context.newRecord;
        var numLines = salesOrder.getLineCount({sublistId: 'item'});
        if (numLines < 2) return;

        var assemblyItemId = salesOrder.getSublistValue({sublistId: 'item', fieldId: 'item', line: 0});
        log.debug('Assembly Item (first line)', assemblyItemId);

        // Find the current BOM Revision for this assembly (latest by effectivefrom)
        var revisionId = getCurrentBomRevisionForAssembly(assemblyItemId);
        if (!revisionId) {
            log.debug('No BOM Revision found for assembly', assemblyItemId);
            return;
        }

        // For each other line, process replacements
        for (var i = 1; i < numLines; i++) {
            var newComponentId = salesOrder.getSublistValue({sublistId: 'item', fieldId: 'item', line: i});
            var oldComponentId = salesOrder.getSublistValue({sublistId: 'item', fieldId: 'custcol_replacement_for', line: i});

            // If Replacement For is a text field, look up the internal ID
            if (oldComponentId && isNaN(oldComponentId)) {
                oldComponentId = getItemIdByName(oldComponentId);
                if (!oldComponentId) {
                    log.error('Could not find item with name', oldComponentId);
                    continue;
                }
            }

            if (oldComponentId) {
                log.debug('Queueing BOM update', 'Revision: ' + revisionId + ', Old: ' + oldComponentId + ', New: ' + newComponentId);

                // 1. Set the end date of the current BOM Revision
                var today = new Date();
                var threeDaysAgo = new Date(today);
                threeDaysAgo.setDate(today.getDate() - 3);
                var yyyy = threeDaysAgo.getFullYear();
                var mm = threeDaysAgo.getMonth() + 1;
                var dd = threeDaysAgo.getDate();
                if (mm < 10) mm = '0' + mm;
                if (dd < 10) dd = '0' + dd;
                var endDate = yyyy + '-' + mm + '-' + dd;

                var origRevision = record.load({
                    type: 'bomrevision',
                    id: revisionId,
                    isDynamic: true
                });
                origRevision.setValue({fieldId: 'effectiveto', value: endDate});
                origRevision.save();

                // 2. Create a custom record to queue the update for Map/Reduce
                var queueRec = record.create({type: 'customrecord_bomrev_update_queue'});
                queueRec.setValue({fieldId: 'name', value: 'BOM Update ' + new Date().getTime()});
                queueRec.setValue({fieldId: 'custrecord_bomrevq_bomrevision', value: revisionId});
                queueRec.setValue({fieldId: 'custrecord_bomrevq_oldcomponent', value: oldComponentId});
                queueRec.setValue({fieldId: 'custrecord_bomrevq_newcomponent', value: newComponentId});
                queueRec.setValue({fieldId: 'custrecord_bomrevq_assembly', value: assemblyItemId});
                queueRec.save();
            }
        }

        // 3. Trigger the Map/Reduce script
        try {
            var mrTask = task.create({
                taskType: task.TaskType.MAP_REDUCE,
                scriptId: 'customscript_bomrev_update_mr', // Replace with your Map/Reduce script ID
                deploymentId: null // Or your deployment ID
            });
            var mrTaskId = mrTask.submit();
            log.audit('Triggered Map/Reduce script', mrTaskId);
        } catch (e) {
            log.error('Failed to trigger Map/Reduce', e);
        }
    }

    // Helper: Get the latest BOM Revision for the assembly
    function getCurrentBomRevisionForAssembly(assemblyItemId) {
        var revisionId = null;
        var latestDate = null;
        var revisionSearch = search.create({
            type: 'bomrevision',
            filters: [],
            columns: [
                {name: 'internalid'}
            ]
        });
        var results = revisionSearch.run().getRange({start: 0, end: 100});
        for (var i = 0; i < results.length; i++) {
            var currId = results[i].getValue('internalid');
            var revRec = record.load({type: 'bomrevision', id: currId, isDynamic: false});
            var bomId = revRec.getValue({fieldId: 'billofmaterials'});
            if (bomId) {
                var bomRec = record.load({type: 'bom', id: bomId, isDynamic: false});
                var restrictToAssembly = bomRec.getValue({fieldId: 'restricttoassembly'});
                // Accept both generic and restricted BOMs
                if (!restrictToAssembly || String(restrictToAssembly) === String(assemblyItemId)) {
                    var effFrom = revRec.getValue({fieldId: 'effectivefrom'});
                    if (!latestDate || new Date(effFrom) > new Date(latestDate)) {
                        latestDate = effFrom;
                        revisionId = currId;
                    }
                }
            }
        }
        return revisionId;
    }

    // Helper: Look up item internal ID by name (if Replacement For is a text field)
    function getItemIdByName(itemName) {
        var itemSearch = search.create({
            type: search.Type.ITEM,
            filters: [
                ['name', 'is', itemName]
            ],
            columns: ['internalid']
        });
        var results = itemSearch.run().getRange({start: 0, end: 1});
        if (results.length) {
            return results[0].getValue('internalid');
        }
        return null;
    }

    return { afterSubmit: afterSubmit };
});