/*****************
 backend/events.js
 *****************

 'backend/events.js' is a reserved Velo file that enables you to handle backend events.

 Many of the Velo backend modules, like 'wix-stores-backend' or 'wix-media-backend', include events that are triggered when 
 specific actions occur on your site. You can write code that runs when these actions occur.

 For example, you can write code that sends a custom email to a customer when they pay for a store order.

 Example: Use the function below to capture the event of a file being uploaded to the Media Manager:

   export function wixMediaManager_onFileUploaded(event) {
       console.log('The file "' + event.fileInfo.fileName + '" was uploaded to the Media Manager');
   }

 ---
 More about Velo Backend Events: 
 https://support.wix.com/en/article/velo-backend-events

*******************/
import { sendOrderToISend } from 'backend/isendService';
import { getByWixOrderId, saveMapping } from 'backend/isendMappings';

/**
 * Wix Stores event handler for new orders.
 * This function runs automatically when a new Wix order is created.
 * It sends the order to iSend and saves the mapping between Wix and iSend order numbers.
 */
export async function wixStores_onNewOrder(event) {
  const order = event.order;
  const wixOrderId = order?._id || order?.id;

  try {
    if (wixOrderId) {
      const existingMapping = await getByWixOrderId(wixOrderId);
      if (existingMapping) {
        console.log('Skipping iStore iSend submit; mapping already exists', {
          wixOrderId,
          iSendOrderNo: existingMapping.iSendOrderNo,
        });
        return;
      }
    }

    const result = await sendOrderToISend(order);
    console.log('iStore iSend order submit result', {
      orderId: wixOrderId,
      success: result?.success,
      skipped: result?.skipped,
      messageCount: result?.msgList?.msgList?.length || 0,
    });

    // Attempt to extract iSend order number from the response and save mapping
    try {
      const iSendOrderNo = (result && (
        result.returnObject && (result.returnObject.custOrderNo || result.returnObject.orderNo || result.returnObject.orderId)
      )) || result.custOrderNo || result.orderNo || result.orderId || null;

      if (wixOrderId && iSendOrderNo) {
        await saveMapping(wixOrderId, iSendOrderNo, { raw: result });
        console.log('Saved iSend mapping', { wixOrderId, iSendOrderNo });
      } else {
        console.log('No iSend order number found in response; mapping not saved', { wixOrderId });
      }
    } catch (e) {
      console.error('Failed to save iSend mapping', e.message);
    }
  } catch (error) {
    console.error('iStore iSend order submit failed', {
      orderId: wixOrderId,
      message: error.message,
    });
  }
}

