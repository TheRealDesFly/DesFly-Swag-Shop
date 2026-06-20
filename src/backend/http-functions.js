/*******************
 http-functions.js
********************

'http-functions.js' is a reserved backend file that lets you expose APIs that respond to fetch 
requests from external services.

Use this file to create functions that expose the functionality of your site as a service. 
This functionality can be accessed by writing code that calls this site's APIs as defined by the 
functions you create here.

To learn more about using HTTP functions, including the endpoints for accessing the APIs, see:
https://wix.to/0lZ9qs8

*********
 Example
*********

The following HTTP function example returns the product of 2 operands.

To call this API, assuming this HTTP function is located in a premium site that is published 
and has the domain "mysite.com", you would use this URL:

https://mysite.com/_functions/multiply?leftOperand=3&rightOperand=4

Note: To access the APIs for your site, use one of the endpoint structures documented here:
https://wix.to/rZ5Dh89

***/

// import { ok, badRequest } from 'wix-http-functions';

// export function get_multiply(request) {

//     const response = {
//         "headers": {
//             "Content-Type": "application/json"
//         }
//     }

//     try {
//         const leftOperand = parseInt(request.query["leftOperand"], 10);
//         const rightOperand = parseInt(request.query["rightOperand"], 10);

//         response.body = {
//             "product": leftOperand * rightOperand
//         }
//         return ok(response);

//     } catch (err) {
//         response.body = {
//             "error": err
//         }
//         return badRequest(response);
//     }
// }

import { ok, serverError } from 'wix-http-functions';
import { testISendLogin } from 'backend/isendService';

export async function get_testISendLoginFromWix(request) {
  try {
    const result = await testISendLogin();
    return ok({
      headers: {
        'Content-Type': 'application/json',
      },
      body: result,
    });
  } catch (error) {
    return serverError({
      headers: {
        'Content-Type': 'application/json',
      },
      body: {
        success: false,
        message: error.message,
      },
    });
  }
}