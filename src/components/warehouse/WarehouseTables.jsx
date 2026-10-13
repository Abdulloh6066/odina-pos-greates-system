import React from 'react';
import { PackagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatNum } from '@/lib/pos';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';

export function WarehouseStockTable({ items, stockMap, kind, location, onAdjust, unitLabels, categoryLabels, sourceLabels }) {
  return (
    <div className="warehouse-table-wrap">
      <table className="warehouse-table">
        <caption className="sr-only">{kind === 'product' ? 'Tayyor mahsulotlar qoldig‘i' : 'Masalliqlar va qadoqlar qoldig‘i'}</caption>
        <thead><tr><th scope="col">Nomi / turi</th><th scope="col">Qoldiq</th><th scope="col">Birlik</th><th scope="col">Holati</th>{onAdjust && <th scope="col">Amal</th>}</tr></thead>
        <tbody>{items.map((item) => {
          const stock = stockMap[item.id];
          const quantity = Number(stock?.quantity || 0);
          const unit = kind === 'ingredient' ? item.base_unit : (stock?.unit || (location?.location_type === 'production' ? item.production_unit || 'piece' : 'piece'));
          return <tr key={item.id}>
            <td data-label="Nomi"><strong>{item.name}</strong><span className="warehouse-cell-note">{kind === 'ingredient' ? (categoryLabels[item.category] || item.category) : (sourceLabels[item.source_type] || 'Markaziy ishlab chiqarishda tayyorlanadi')}</span></td>
            <td data-label="Qoldiq" className="warehouse-number">{formatNum(quantity)}</td>
            <td data-label="Birlik">{unitLabels[unit] || unit}</td>
            <td data-label="Holati"><span className={`warehouse-status ${quantity > 0 ? 'bg-emerald-50 text-emerald-700' : quantity < 0 ? 'bg-red-50 text-destructive' : 'bg-secondary text-muted-foreground'}`}>{quantity > 0 ? 'Mavjud' : quantity < 0 ? 'Manfiy qoldiq' : 'Qoldiq yo‘q'}</span></td>
            {onAdjust && <td data-label="Amal"><Button type="button" variant="outline" onClick={() => onAdjust(item)} aria-label={item.name + ' — qoldiqni tuzatish'}><PackagePlus className="w-4 h-4 mr-2 shrink-0" aria-hidden="true" />{kind === 'product' ? 'Qoldiqni tuzatish' : 'Qoldiq / tuzatish'}</Button></td>}
          </tr>;
        })}</tbody>
      </table>
    </div>
  );
}

export function WarehouseHistoryTable({ movements, movementLabels, unitLabels }) {
  return <div className="warehouse-table-wrap"><table className="warehouse-table">
    <caption className="sr-only">Ombor harakatlari tarixi</caption>
    <thead><tr><th scope="col">Mahsulot / amal</th><th scope="col">O‘zgarish</th><th scope="col">Qoldiq</th><th scope="col">Xodim</th><th scope="col">Sana</th></tr></thead>
    <tbody>{movements.map((movement) => <tr key={movement.id}>
      <td data-label="Mahsulot"><strong>{movement.item_name}</strong><span className="warehouse-cell-note">{movementLabels[movement.movement_type] || movement.movement_type}{movement.reason ? ' · ' + movement.reason : ''}</span></td>
      <td data-label="O‘zgarish" className={`warehouse-number ${movement.quantity_change > 0 ? 'text-emerald-700' : 'text-destructive'}`}>{movement.quantity_change > 0 ? '+' : ''}{formatNum(movement.quantity_change)} {unitLabels[movement.unit] || movement.unit}</td>
      <td data-label="Qoldiq" className="warehouse-number">{formatNum(movement.balance_before)} → {formatNum(movement.balance_after)}</td>
      <td data-label="Xodim">{movement.user_name}</td>
      <td data-label="Sana">{formatUzbekistanDateTime(movement.created_at || movement.created_date)}</td>
    </tr>)}</tbody>
  </table></div>;
}
