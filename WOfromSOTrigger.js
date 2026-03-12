/**
 * @NApiVersion 2.x
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/runtime', 'N/task', 'N/search'],
function(record, runtime, task, search) {

    function afterSubmit(context) {
        if (context.type !== context.UserEventType.CREATE) return;

        var workOrder = context.newRecord;
        var createdFrom = workOrder.getValue({ fieldId: 'createdfrom' });

        if (!createdFrom) return; // Not created from a Sales Order

        // Load the Sales Order to check if the "Create Work Order" box was checked
        var salesOrder = record.load({
            type: record.Type.SALES_ORDER,
            id: createdFrom
        });

        var numLines = salesOrder.getLineCount({ sublistId: 'item' });
        var triggered = false;

        for (var i = 0; i < numLines; i++) {
            var createWO = salesOrder.getSublistValue({
                sublistId: 'item',
                fieldId: 'createwo',
                line: i
            });
            if (createWO) {
                triggered = true;
                break;
            }
        }

        if (triggered) {
            // Schedule the Map/Reduce script
            var mrTask = task.create({
                taskType: task.TaskType.MAP_REDUCE,
                scriptId: 'customscript_crc_rn_wo_mr', // Replace with your Map/Reduce script ID
                deploymentId: 'customdeploy_crc_rn_wo_mr', // Replace with your deployment ID
                params: {
                    custscript_workorder_id: workOrder.id // Pass the Work Order ID if needed
                }
            });
            mrTask.submit();
        }
    }

    return {
        afterSubmit: afterSubmit
    };
});