import { readBrandStorage } from './brandStorage';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

// Helper method for HTTP requests with Authorization header
export async function request(endpoint, options = {}) {
  const token = readBrandStorage('token');
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (token && !headers.Authorization) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Remove Content-Type if uploading FormData
  if (options.body instanceof FormData) {
    delete headers['Content-Type'];
  }

  const config = {
    ...options,
    headers,
  };

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, config);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || `API error (${response.status})`);
    }

    return data;
  } catch (error) {
    console.error(`[API Call Failed] ${endpoint}:`, error.message);
    throw error;
  }
}

// ── Auth Services ──
export const loginApi = (credentials) => request('/auth/login', { method: 'POST', body: JSON.stringify(credentials) });
export const registerApi = (userData) => request('/auth/register', { method: 'POST', body: JSON.stringify(userData) });
export const getMeApi = () => request('/auth/me');
export const updateProfileApi = (profileData) => request('/auth/profile', { method: 'PUT', body: JSON.stringify(profileData) });
export const logoutApi = () => request('/auth/logout', { method: 'POST' });

// ── User Management (Admin) ──
export const getUsersApi = (params = {}) => {
  const query = new URLSearchParams(params).toString();
  return request(`/users${query ? `?${query}` : ''}`);
};
export const createUserApi = (userData) => request('/users', { method: 'POST', body: JSON.stringify(userData) });
export const updateUserApi = (id, data) => request(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteUserApi = (id) => request(`/users/${id}`, { method: 'DELETE' });

// ── Module 3: Emergency & SOS Services ──
export const triggerEmergencyApi = (data) => request('/emergency/trigger', { method: 'POST', body: JSON.stringify(data) });
export const getActiveEmergenciesApi = () => request('/emergency/active');
export const getEmergenciesApi = (params = {}) => {
  const query = new URLSearchParams(params).toString();
  return request(`/emergency/incidents${query ? `?${query}` : ''}`);
};
export const getEmergencyByIdApi = (id) => request(`/emergency/incidents/${id}`);
export const acknowledgeEmergencyApi = (id) => request(`/emergency/incidents/${id}/acknowledge`, { method: 'PATCH' });
export const respondEmergencyApi = (id, data) => request(`/emergency/incidents/${id}/respond`, { method: 'PATCH', body: JSON.stringify(data) });
export const setBuzzerApi = (id, buzzerState) => request(`/emergency/incidents/${id}/buzzer`, { method: 'PATCH', body: JSON.stringify({ buzzerState }) });
export const resolveEmergencyApi = (id, resolutionNotes) => request(`/emergency/incidents/${id}/resolve`, { method: 'PATCH', body: JSON.stringify({ resolutionNotes }) });
export const createEmergencyMaintenanceApi = (id, data) => request(`/emergency/incidents/${id}/maintenance`, { method: 'POST', body: JSON.stringify(data) });

// ── Module 4: Maintenance Management Services ──
export const getMaintenanceTicketsApi = (params = {}) => {
  const query = new URLSearchParams(params).toString();
  return request(`/maintenance/tickets${query ? `?${query}` : ''}`);
};
export const createMaintenanceTicketApi = (data) => request('/maintenance/tickets', { method: 'POST', body: JSON.stringify(data) });
export const getMaintenanceTicketByIdApi = (id) => request(`/maintenance/tickets/${id}`);
export const updateMaintenanceTicketApi = (id, data) => request(`/maintenance/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const assignTechnicianApi = (id, data) => request(`/maintenance/tickets/${id}/assign`, { method: 'PATCH', body: JSON.stringify(data) });
export const updateTicketStatusApi = (id, status, notes) => request(`/maintenance/tickets/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status, notes }) });
export const addTicketNoteApi = (id, text) => request(`/maintenance/tickets/${id}/notes`, { method: 'POST', body: JSON.stringify({ text }) });
export const uploadTicketPhotoApi = (id, photo) => request(`/maintenance/tickets/${id}/photos`, { method: 'POST', body: JSON.stringify(photo) });
export const verifyMaintenanceTicketApi = (id, data) => request(`/maintenance/tickets/${id}/verify`, { method: 'PATCH', body: JSON.stringify(data) });
export const reopenMaintenanceTicketApi = (id, data) => request(`/maintenance/tickets/${id}/reopen`, { method: 'PATCH', body: JSON.stringify(data) });
export const recordRepairCompletedApi = (id, data) => request(`/maintenance/tickets/${id}/repair`, { method: 'POST', body: JSON.stringify(data) });
export const getMaintenanceTicketHistoryApi = (id) => request(`/maintenance/tickets/${id}/history`);
export const getMaintenanceStatsApi = () => request('/maintenance/stats');

// ── Module 5: Historical Analytics Services ──
export const getHistoricalTrendsApi = (params = {}) => {
  const query = new URLSearchParams(params).toString();
  return request(`/analytics/historical${query ? `?${query}` : ''}`);
};
export const getAnomaliesApi = (params = {}) => {
  const query = new URLSearchParams(params).toString();
  return request(`/analytics/anomalies${query ? `?${query}` : ''}`);
};
export const getRiskRankingsApi = () => request('/analytics/risk-rankings');
export const getPerformanceMetricsApi = () => request('/analytics/performance');
export const getModelStatusApi = () => request('/analytics/model-status');
export const getIncidentsSummaryApi = (params = {}) => {
  const query = new URLSearchParams(params).toString();
  return request(`/analytics/incidents-summary${query ? `?${query}` : ''}`);
};
export const getDeviceHealthAnalyticsApi = () => request('/analytics/device-health');
export const getSecurityAnalyticsSummaryApi = () => request('/analytics/security-summary');
export const getSosMetricsApi = () => request('/analytics/sos-metrics');
export const getMaintenanceAnalyticsMetricsApi = () => request('/analytics/maintenance-metrics');
export const runHistoricalAnalysisApi = (data) => request('/analytics/run-analysis', {
  method: 'POST',
  body: JSON.stringify(data),
});

// ── Module 6: Central Dashboard & Access Control Services ──
export const getDashboardSummaryApi = () => request('/dashboard/summary');
export const getDashboardActivityApi = (params = {}) => {
  const query = new URLSearchParams(params).toString();
  return request(`/dashboard/activity${query ? `?${query}` : ''}`);
};
export const getDashboardModuleAccessApi = () => request('/dashboard/module-access');

// ── Legacy Compatibility ──
export const getTeamMembersApi = (params) => getUsersApi(params);
export const inviteTeamMemberApi = (memberData) => createUserApi(memberData);
export const getSafetyReadingsApi = (token) => request('/iot/readings', {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(10000),
});
