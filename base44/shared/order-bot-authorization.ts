import { resolveAppUser } from './user-helpers.ts';

// Internal bot-only policy. No User record or canonical POS policy is changed.
export async function resolveOrderBotStaff(service: any, staffId: string, binding: any = null, selectedShop = '') {
  const user = await resolveAppUser(service, { id: staffId });
  if (user.id !== staffId || user.disabled === true || user.data?.disabled === true
    || !['admin', 'manager', 'cashier'].includes(user.role)) throw new Error('Faol xodim ruxsati topilmadi.');
  if (binding && (binding.enabled !== true || binding.staff_id !== staffId)) throw new Error('Xodim biriktirilishi noto‘g‘ri.');
  const activePosShop = async (id: string) => {
    const shop = id ? await service.entities.Shop.get(id) : null;
    return shop && shop.active !== false && shop.allows_pos !== false && shop.location_type !== 'production' ? shop : null;
  };
  if (binding?.scope_policy === 'owner_choose_shop') {
    if (!user.is_owner || user.role !== 'admin') throw new Error('Do‘kon tanlashga ruxsat yo‘q.');
    // Explicit server-controlled allowlist. Neither email nor Telegram text grants ownership.
    const ids = binding.owner_shop_ids;
    if (!Array.isArray(ids) || ids.length !== 2 || new Set(ids).size !== 2) throw new Error('Do‘konlar sozlanmagan.');
    const shops = await Promise.all(ids.map(activePosShop));
    const choices = shops.filter(Boolean).map((s: any) => ({ id: s.id, name: s.name }));
    if (!choices.length || (selectedShop && !choices.some((s: any) => s.id === selectedShop))) throw new Error('Tanlangan do‘kon faol emas.');
    return { ...user, shop_id: selectedShop, shop_name: choices.find((s: any) => s.id === selectedShop)?.name || '', owner_shop_choices: choices };
  }
  if (binding && (binding.scope_policy !== 'assigned_shop' || binding.owner_shop_ids?.length)) throw new Error('Xodim biriktirilishi noto‘g‘ri.');
  const shop = await activePosShop(user.shop_id);
  if (!shop || (selectedShop && selectedShop !== shop.id)) throw new Error('Faol do‘kon biriktirilmagan.');
  return { ...user, shop_id: shop.id, shop_name: shop.name };
}
