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

export async function wixStores_onNewOrder(event) {
  const order = event.order;

  try {
    const result = await sendOrderToISend(order);
    console.log('iStore iSend order submit result', {
      orderId: order?._id || order?.id,
      success: result?.success,
      messageCount: result?.msgList?.msgList?.length || 0,
    });
  } catch (error) {
    console.error('iStore iSend order submit failed', {
      orderId: order?._id || order?.id,
      message: error.message,
    });
  }
}

