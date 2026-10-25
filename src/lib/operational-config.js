// Business screens consume a fixed projection, never the raw administration record.
export async function loadOperationalSettings(client) {
  const response = await client.functions.invoke('manager-shop', { action: 'get_operational_settings' });
  const payload = response?.data || response;
  if (payload?.error || !payload?.settings || typeof payload.settings !== 'object' || Array.isArray(payload.settings)) {
    throw new Error(payload?.error || 'Kassa parametrlari yuklanmadi. Qayta urinib ko‘ring.');
  }
  return payload.settings;
}

export async function loadExportHistory(client, role) {
  if (role !== 'manager') return client.entities.DailyShopReport.list('-business_date', 100);
  const response = await client.functions.invoke('daily-sales-export', { action: 'history' });
  const payload = response?.data || response;
  if (payload?.error || !Array.isArray(payload?.reports)) throw new Error(payload?.error || 'Hisobot tarixi yuklanmadi.');
  return payload.reports;
}
