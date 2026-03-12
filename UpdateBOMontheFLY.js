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
            var itemId = salesOrder.getSublistValue({sublistId: 'item', fieldId: 'item', line: i});
            var oldComponentId = salesOrder.getSublistValue({sublistId: 'item', fieldId: 'custcol_replacement_for', line: i});
            if (!oldComponentId) continue;
            if (isNaN(oldComponentId)) {
                oldComponentId = getItemIdByName(oldComponentId);
                if (!oldComponentId) continue;
            }
            var queueRec = record.create({type: 'customrecord_bomrev_update_queue'});
            queueRec.setValue({fieldId: 'name', value: 'BOM Update ' + new Date().getTime()});
            queueRec.setValue({fieldId: 'custrecord_bomrevq_bomrevision', value: revisionId});
            queueRec.setValue({fieldId: 'custrecord_bomrevq_assembly', value: assemblyItemId});
            queueRec.setValue({fieldId: 'custrecord_bomrevq_oldcomponent', value: oldComponentId});
            queueRec.setValue({fieldId: 'custrecord_bomrevq_newcomponent', value: itemId});
            queueRec.save();
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
                    var effFrom = revRec.getValue({fieldId: 'effectivestartdate'});
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

    function closeOverlappingRevisions(bomId, newRevisionStartDate, formatDate) {
        log.debug('Starting closeOverlappingRevisions', {bomId: bomId, newRevisionStartDate: newRevisionStartDate});
        var revisionSearch = search.create({
            type: 'bomrevision',
            filters: [
                ['billofmaterials', 'anyof', bomId]
            ],
            columns: ['internalid', 'effectivestartdate', 'effectiveenddate']
        });
        var prevEnd = new Date(newRevisionStartDate);
        prevEnd.setDate(prevEnd.getDate() - 1);
        var prevEndStr = formatDate(prevEnd);

        var revisionCount = 0;
        revisionSearch.run().each(function(result) {
            revisionCount++;
            var revId = result.getValue('internalid');
            var effFrom = result.getValue('effectivestartdate');
            var effTo = result.getValue('effectiveenddate');
            log.debug('Checking revision for overlap', {revId: revId, effFrom: effFrom, effTo: effTo});
            if ((!effTo || new Date(effTo) >= newRevisionStartDate) && new Date(effFrom) <= newRevisionStartDate) {
                try {
                    log.debug('About to load revision to close', revId);
                    var revRec = record.load({type: 'bomrevision', id: revId, isDynamic: true});
                    log.debug('Loaded revision', revId);
                    revRec.setValue({fieldId: 'effectiveenddate', value: prevEndStr});
                    log.debug('Saving revision', revId);
                    revRec.save();
                    log.debug('Saved revision', revId);
                } catch (e) {
                    log.error('Failed to close overlapping revision', {revId: revId, error: e});
                }
            }
            return true; // continue to next result
        });
        log.debug('Revision count for BOM', {bomId: bomId, count: revisionCount});
    }

    return { afterSubmit: afterSubmit };
});