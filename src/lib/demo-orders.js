import { pad2, tashkentNowParts } from './orders.js';

// Display-only examples. Never pass these records to Base44 entities or order actions.
export function buildDemoOrders() {
  const { year, month, day } = tashkentNowParts();
  const date = (offset) => {
    const value = new Date(Date.UTC(year, month - 1, day + offset));
    return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
  };
  const sample = (number, details, lines) => ({
    id: `demo-${number}`,
    order_number: `NAMUNA-${number}`,
    customer_phone: '—',
    shop_name_snapshot: 'Namuna',
    delivery_address: '',
    ...details,
    demo_lines: lines.map(([name, quantity, unit], index) => ({
      id: `demo-${number}-item-${index}`,
      product_name_snapshot: name,
      quantity,
      unit_snapshot: unit,
    })),
    demo_items: lines.map(([name, quantity, unit]) => `${name} — ${quantity} ${unit === 'sheet' ? 'list' : 'dona'}`).join('; '),
  });

  return [
    sample('01', {
      customer_name: 'To‘y uchun list buyurtmasi', order_type: 'toy_va_bazmlar',
      fulfilment_type: 'pickup', required_date: date(0), required_time: '21:00',
      order_status: 'qabul_qilindi', payment_status: 'partial',
      total: 1200000, remaining_balance: 800000,
    }, [['МАЛАКОЛИ ПИРОГ', 2, 'sheet'], ['МАЛИНА ПИРОК', 1, 'sheet']]),
    sample('02', {
      customer_name: 'Tug‘ilgan kun torti', order_type: 'tugilgan_kun_va_boshqa',
      fulfilment_type: 'pickup', required_date: date(0), required_time: '18:00',
      order_status: 'tayyorlanmoqda', payment_status: 'unpaid',
      total: 260000, remaining_balance: 260000,
    }, [['МАТИЛДА', 1, 'piece']]),
    sample('03', {
      customer_name: 'Bazm uchun aralash listlar', order_type: 'toy_va_bazmlar',
      fulfilment_type: 'delivery', delivery_address: 'Yetkazish manzili namunasi',
      required_date: date(1), required_time: '13:00',
      order_status: 'qabul_qilindi', payment_status: 'partial',
      total: 950000, remaining_balance: 450000,
    }, [['СУТЛИ ПИРОГ', 2, 'sheet'], ['ОЛМАЛИ ПИРОГ', 1, 'sheet']]),
    sample('04', {
      customer_name: 'Olib ketiladigan buyurtma', order_type: 'tugilgan_kun_va_boshqa',
      fulfilment_type: 'pickup', required_date: date(1), required_time: '18:00',
      order_status: 'tayyor', payment_status: 'paid',
      total: 180000, remaining_balance: 0,
    }, [['САН СЕБЯСТАН', 1, 'sheet']]),
  ];
}
