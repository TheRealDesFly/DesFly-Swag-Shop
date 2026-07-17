function unconfigured(name) {
  throw new Error(`Unconfigured wix-data mock: ${name}`);
}

const wixData = {
  insert: (...args) => unconfigured(`insert(${args.length})`),
  update: (...args) => unconfigured(`update(${args.length})`),
  remove: (...args) => unconfigured(`remove(${args.length})`),
  query: (...args) => unconfigured(`query(${args.length})`),
};

export default wixData;
