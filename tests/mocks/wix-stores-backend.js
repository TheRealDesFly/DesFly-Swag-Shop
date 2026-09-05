function unconfigured() { throw new Error('Unconfigured wix-stores-backend mock'); }
export default {
  getProductVariants: unconfigured,
  updateInventoryVariantFieldsByProductId: unconfigured,
};
