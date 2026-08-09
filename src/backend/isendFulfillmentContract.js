import { getSecret } from 'wix-secrets-backend';

export const ISEND_SINGLE_PARCEL_CONTRACT_SECRET =
  'ISTORE_ISEND_SINGLE_PARCEL_CONTRACT_CONFIRMED';

/**
 * Fulfillment is destructive and the current integration can only allocate
 * every Wix line item to one parcel. Absence of split-shipment evidence is not
 * proof of completeness, so this gate defaults closed until the partner's
 * single-parcel contract is explicitly confirmed in the backend secret store.
 */
export async function isISendSingleParcelContractConfirmed() {
  try {
    const configured = await getSecret(ISEND_SINGLE_PARCEL_CONTRACT_SECRET);
    return String(configured || '').trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

export default {
  isISendSingleParcelContractConfirmed,
};
