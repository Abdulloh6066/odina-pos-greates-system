import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { startReceiptPrint } from '@/lib/receipt-print-lifecycle';
import { REQUISITION_UNITS, requisitionGroups, requisitionNumber } from '@/lib/ingredient-requisitions';

export function IngredientRequisitionTicketContent({ request }) {
  return <div className="ir-ticket-content">
    <header><strong>{request.location_name}</strong><h2>ERTAGA KERAK</h2><p>Mahsulot talabnomasi</p></header>
    <div className="ir-ticket-meta"><b>{request.request_number}</b><div>Kerakli sana: <b>{request.required_date.split('-').reverse().join('.')}</b></div>
      <div>{request.source_kind === 'warehouse' ? `Manba: ${request.source_location_name}` : 'Manba: Xarid'}</div></div>
    <table><colgroup><col style={{ width: '34%' }} /><col style={{ width: '16%' }} /><col style={{ width: '25%' }} /><col style={{ width: '25%' }} /></colgroup>
      <thead><tr><th>Mahsulot</th><th>Miqdor</th><th>Narx<small>1 birlik</small></th><th>Jami</th></tr></thead>
      {requisitionGroups(request.items).map(group => <tbody key={group.title}><tr className="ir-ticket-group"><th colSpan={4}>{group.title}</th></tr>
        {group.items.map(item => <tr key={item.ingredient_id}><td><span className="ir-paper-check" />{item.ingredient_name}</td>
          <td className="ir-ticket-quantity"><b>{requisitionNumber(item.requested_quantity)}</b><small>{REQUISITION_UNITS[item.purchase_unit]}</small></td>
          <td className="ir-write-cell"><span /></td><td className="ir-write-cell"><span /></td></tr>)}
      </tbody>)}
      <tfoot><tr><th colSpan={3}>UMUMIY PUL (so‘m)</th><td /></tr></tfoot>
    </table>
    <div className="ir-ticket-notes"><b>Izoh:</b> {request.notes || ''}<div className="ir-pen-line" /></div>
    <footer><div>Tuzgan: {request.created_by_name}</div><div className="ir-pen-line">Qabul qilgan:</div><p>Kelgan miqdor va narx saytda tekshiriladi.</p></footer>
  </div>;
}

export default function IngredientRequisitionTicket({ request, onAfterPrint, onWarning }) {
  const done = useRef(onAfterPrint), warning = useRef(onWarning);
  useEffect(() => { done.current = onAfterPrint; warning.current = onWarning; }, [onAfterPrint, onWarning]);
  useEffect(() => {
    if (!request) return undefined;
    return startReceiptPrint({ printClass: 'odina-requisition-printing',
      onDone: () => done.current?.(), onWarning: message => warning.current?.(message),
      warningMessage: 'Talabnoma saqlangan. Chek chiqmagan bo‘lsa, shu ro‘yxatdan qayta chiqaring.' });
  }, [request]);
  if (!request) return null;
  return createPortal(<div className="receipt-print ingredient-requisition-ticket hidden"><IngredientRequisitionTicketContent request={request} /></div>, document.body);
}
