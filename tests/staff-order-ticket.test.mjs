import test from 'node:test';
import assert from 'node:assert/strict';
import { staffTicketFromSale, staffTicketFromCustomerOrder } from '../src/lib/staff-order-ticket.js';

test('ordinary sale staff ticket uses the saved sale snapshot without payment details', () => {
  const sale = {
    id: 's-1', sale_number: 32, shop_name: 'Markaz', user_name: 'Kassir',
    sold_at: '2026-09-19T12:00:00Z', total: 99000,
    payments: [{ amount: 99000, method: 'cash' }],
    items: [{ product_name: 'Qahva', quantity: 2, subtotal: 50000 }],
  };
  const ticket = staffTicketFromSale(sale);
  assert.equal(ticket.number, 32);
  assert.equal(ticket.items[0].product_name, 'Qahva');
  assert.equal(ticket.items[0].quantity, 2);
  assert.equal(ticket.opened_by_name, 'Kassir');
  assert.equal(ticket.total, undefined);
  assert.equal(ticket.payments, undefined);
  sale.items[0].product_name = 'Changed after sale';
  assert.equal(ticket.items[0].product_name, 'Qahva');
});

test('delivery ticket keeps saved customer, address, deadline, and customization', () => {
  const order = {
    id: 'o-1', order_number: 'O-42', shop_name_snapshot: 'Filial',
    customer_name: 'Ali', customer_phone: '998-90-000-00-00',
    fulfilment_type: 'delivery', delivery_address: 'Mustaqillik 12',
    required_date: '2026-09-23', required_time: '14:30', creator_name: 'Nodira',
    total: 150000, remaining_balance: 80000,
  };
  const ticket = staffTicketFromCustomerOrder(order, [
    { product_name_snapshot: 'Paxlava', quantity: 3, unit_snapshot: 'sheet', customization_note: 'Yong‘oqsiz' },
  ]);
  assert.equal(ticket.fulfilment_type, 'delivery');
  assert.equal(ticket.delivery_address, 'Mustaqillik 12');
  assert.equal(ticket.customer_name, 'Ali');
  assert.equal(ticket.required_time, '14:30');
  assert.deepEqual(ticket.items, [{
    product_name: 'Paxlava', quantity: 3, unit_label: 'varaq', notes: 'Yong‘oqsiz',
  }]);
  assert.equal(ticket.remaining_balance, undefined);
});

test('pickup ticket does not copy a stale delivery address', () => {
  const ticket = staffTicketFromCustomerOrder({
    id: 'o-2', fulfilment_type: 'pickup', delivery_address: 'Old address',
  }, [{ product_name_snapshot: 'Tort', quantity: 1, unit_snapshot: 'piece' }]);
  assert.equal(ticket.delivery_address, '');
  assert.equal(ticket.items[0].unit_label, 'ta');
});
