const catalog = require('../../src/data/tempers.json');
const id = value => ({ $oid: value.toString(16).padStart(24, '0') });
const weaponPath = name => Object.keys(catalog.weapons).find(path => catalog.weapons[path].name === name);
const temperProgress = (tag, count) => ({ ItemType: '/SF/Types/Items/Aspects/Tempers/' + tag, ItemCount: count });
function weapon(number, name, tags = []) {
  const path = weaponPath(name);
  // Game paths are case-sensitive; the tracker normalizes them for catalogue lookup.
  return { ItemId: id(number), ItemType: '/SF/' + path.slice(4), Quality: 'IQ_LEGENDARY', Configs: [{}, {}],
    AspectFingerprint: JSON.stringify({ buffs: tags.map(Tag => ({ Tag, Value: 2147483647 })), curses: [{ Tag: 'AttackSpeedMod' }] }) };
}
function temperInventory() {
  return { AccountId: 'private-account', Nonce: 'private-nonce',
    RawUpgrades: [temperProgress('BlockingLessStaggerMod', 10), temperProgress('StaggerCritMod', 4), temperProgress('AttackSpeedMod', 9)],
    CurrentLoadOutIds: [id(100)], LoadOutPresets: { NORMAL: [{ ItemId: id(100), m: { ItemId: id(1) }, l: { ItemId: id(3) } }] },
    Melee: [weapon(1, 'Vetch', ['BlockingLessStaggerMod', 'BlockingLessStaggerMod', 'StaggerCritMod']), weapon(2, 'Vetch', ['StaggerCritMod'])],
    LongGuns: [weapon(3, 'Seathorn', ['HeavyAttackDamageAndStaggerMod', 'HeavyAttackDamageAndStaggerMod'])],
  };
}
module.exports = { temperInventory, temperProgress, weapon, id };
