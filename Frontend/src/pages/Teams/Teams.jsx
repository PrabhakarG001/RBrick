import React, { useState, useEffect } from 'react';
import '../Dashboard/Dashboard.css';
import { useAuth } from '../../context/AuthContext';
import { getUsersApi, createUserApi, updateUserApi } from '../../services/api';

const ROLES = [
  { value: 'student', label: 'Student' },
  { value: 'faculty_staff', label: 'Faculty / Staff' },
  { value: 'security_guard', label: 'Security Guard' },
  { value: 'maintenance_staff', label: 'Maintenance Staff' },
  { value: 'facility_manager', label: 'Facility Manager' },
  { value: 'admin', label: 'Administrator' },
];

export const Teams = () => {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.permissions?.includes('*');

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');

  // New user form state
  const [formOpen, setFormOpen] = useState(false);
  const [newUser, setNewUser] = useState({
    name: '',
    email: '',
    role: 'student',
    department: '',
    phone: '',
  });
  const [submitting, setSubmitting] = useState(false);

  const fetchUsers = async () => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (search) params.search = search;
      if (roleFilter) params.role = roleFilter;
      const res = await getUsersApi(params);
      if (res.success) {
        setUsers(res.items || []);
      }
    } catch (err) {
      setError(err.message || 'Unable to load user directory (requires Admin privileges)');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, [search, roleFilter]);

  const handleCreateUser = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    setNotice('');
    try {
      const res = await createUserApi(newUser);
      if (res.success) {
        setNotice(`User account created for ${newUser.name} with role ${newUser.role}`);
        setNewUser({ name: '', email: '', role: 'student', department: '', phone: '' });
        setFormOpen(false);
        fetchUsers();
      }
    } catch (err) {
      setError(err.message || 'Failed to create user');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRoleChange = async (userId, newRole) => {
    try {
      const res = await updateUserApi(userId, { role: newRole });
      if (res.success) {
        setNotice(`Role updated for user`);
        fetchUsers();
      }
    } catch (err) {
      setError(err.message || 'Failed to update role');
    }
  };

  const handleToggleActive = async (userId, currentActive) => {
    try {
      const res = await updateUserApi(userId, { isActive: !currentActive });
      if (res.success) {
        setNotice(`User status updated`);
        fetchUsers();
      }
    } catch (err) {
      setError(err.message || 'Failed to update status');
    }
  };

  return (
    <div className="dashboard-container">
      <div className="db-header">
        <div>
          <h1 className="db-title">User Management &amp; Role-Based Access Control</h1>
          <p className="db-subtitle">
            Manage authenticated users, assign operational roles (Students, Faculty, Security, Maintenance, Facility Managers, Admins), and enforce backend permissions.
          </p>
        </div>
        {isAdmin && (
          <button 
            className="db-tab db-tab--active" 
            onClick={() => setFormOpen(!formOpen)}
          >
            {formOpen ? 'Cancel' : '+ Add User'}
          </button>
        )}
      </div>

      {notice && <p className="db-subtitle text-green-600 font-medium" role="status">{notice}</p>}
      {error && <p className="db-subtitle text-red-600 font-medium" role="alert">{error}</p>}

      {formOpen && isAdmin && (
        <section className="db-chart-card safety-section" aria-label="Add new user">
          <h2 className="db-card-title">Register / Invite New User</h2>
          <form className="safety-form" onSubmit={handleCreateUser}>
            <label>
              Full name
              <input 
                className="safety-input" 
                required 
                maxLength={100}
                value={newUser.name} 
                onChange={e => setNewUser({ ...newUser, name: e.target.value })} 
                placeholder="e.g. Jane Smith"
              />
            </label>
            <label>
              Email address
              <input 
                type="email" 
                className="safety-input" 
                required 
                value={newUser.email} 
                onChange={e => setNewUser({ ...newUser, email: e.target.value })} 
                placeholder="jane.smith@campus.edu"
              />
            </label>
            <label>
              Assigned Role
              <select 
                className="safety-input"
                value={newUser.role}
                onChange={e => setNewUser({ ...newUser, role: e.target.value })}
              >
                {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </label>
            <label>
              Department / Area
              <input 
                className="safety-input" 
                maxLength={100}
                value={newUser.department} 
                onChange={e => setNewUser({ ...newUser, department: e.target.value })} 
                placeholder="e.g. Campus Security, Facilities, Student"
              />
            </label>
            <label>
              Phone (optional)
              <input 
                className="safety-input" 
                maxLength={30}
                value={newUser.phone} 
                onChange={e => setNewUser({ ...newUser, phone: e.target.value })} 
                placeholder="+91..."
              />
            </label>
            <div className="safety-controls">
              <button className="db-tab db-tab--active" disabled={submitting}>
                {submitting ? 'Creating account...' : 'Save User Account'}
              </button>
              <button type="button" className="db-tab" onClick={() => setFormOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Filter and User Directory Table */}
      <section className="db-chart-card safety-section">
        <div className="safety-controls safety-section">
          <label>
            Search user
            <input 
              className="safety-input" 
              placeholder="Filter by name, email, department..." 
              value={search} 
              onChange={e => setSearch(e.target.value)}
            />
          </label>
          <label>
            Role
            <select 
              className="safety-input" 
              value={roleFilter} 
              onChange={e => setRoleFilter(e.target.value)}
            >
              <option value="">All Roles</option>
              {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          <button className="db-tab" onClick={fetchUsers} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh Users'}
          </button>
        </div>

        <div className="safety-table-wrap">
          <table className="safety-table">
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Email</th>
                <th scope="col">Department</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                {isAdmin && <th scope="col">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {users.length > 0 ? (
                users.map(u => (
                  <tr key={u.userId || u.id}>
                    <td>
                      <strong>{u.name}</strong>
                      <small className="safety-small">{u.userId}</small>
                    </td>
                    <td>{u.email}</td>
                    <td>{u.department || 'General'}</td>
                    <td>
                      {isAdmin ? (
                        <select 
                          className="safety-input" 
                          style={{ padding: '4px 8px', fontSize: '13px' }}
                          value={u.role}
                          onChange={e => handleRoleChange(u.userId || u.id, e.target.value)}
                        >
                          {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                      ) : (
                        <span className="db-badge">{ROLES.find(r => r.value === u.role)?.label || u.role}</span>
                      )}
                    </td>
                    <td>
                      <span className={`db-badge ${u.isActive ? 'db-badge--review' : 'db-badge--fraud'}`}>
                        {u.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    {isAdmin && (
                      <td>
                        <button 
                          className="db-tab"
                          onClick={() => handleToggleActive(u.userId || u.id, u.isActive)}
                        >
                          {u.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={isAdmin ? 6 : 5} style={{ textAlign: 'center', padding: '24px' }}>
                    {loading ? 'Loading users...' : 'No registered users match this filter.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Core Engineering Team */}
      <h2 className="db-section-label mt-8">Engineering Team &amp; System Architects</h2>
      <div className="db-stats-grid">
        {[
          ['PG', 'Prabhakar Gupta', 'Full-Stack Developer & Systems Architect'],
          ['PM', 'Priyanshu Mishra', 'AI & ML Integration Engineer'],
          ['RN', 'Ravi Nandan', 'IoT & Embedded Hardware Engineer']
        ].map(([initial, name, role]) => (
          <section className="db-stat-card" key={initial}>
            <h2 className="db-card-title">{initial} | {name}</h2>
            <p className="db-subtitle">{role}</p>
          </section>
        ))}
      </div>
    </div>
  );
};
