import './Profile.css';
import React, { useState, useEffect } from "react";
import { HiOutlineChevronRight } from "react-icons/hi2";
import { useAuth } from '../../context/AuthContext';

export const Profile = () => {
  const { user, updateProfile } = useAuth();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (user?.name) {
      const parts = user.name.split(' ');
      setFirstName(parts[0] || '');
      setLastName(parts.slice(1).join(' ') || '');
    }
    setPhone(user?.phone || '');
  }, [user]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setStatusMsg('');
    setErrorMsg('');
    try {
      const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();
      await updateProfile({ name: fullName, phone });
      setStatusMsg('Profile updated successfully.');
    } catch (err) {
      setErrorMsg(err.message || 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="profile-cls-1">
      <h1 className="profile-cls-2">
        Profile
      </h1>

      <form onSubmit={handleSave} className="profile-cls-3">
        {/* First Name */}
        <div className="profile-cls-4">
          <label className="profile-cls-5">
            First name
          </label>
          <input 
            type="text" 
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            required
            className="profile-cls-6"
          />
        </div>

        {/* Last Name */}
        <div className="profile-cls-7">
          <label className="profile-cls-8">
            Last name
          </label>
          <input 
            type="text" 
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className="profile-cls-9"
          />
        </div>

        {/* Email */}
        <div className="profile-cls-10">
          <label className="profile-cls-11">
            Email
          </label>
          <input 
            type="email" 
            value={user?.email || 'operator@resilliox.local'}
            readOnly
            title="Email cannot be changed directly"
            className="profile-cls-12"
            style={{ opacity: 0.8, cursor: 'not-allowed' }}
          />
        </div>

        {/* Phone */}
        <div className="profile-cls-10">
          <label className="profile-cls-11">
            Phone
          </label>
          <input 
            type="tel" 
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91..."
            className="profile-cls-12"
          />
        </div>

        {/* Role & Access (Read only) */}
        <div className="profile-cls-10">
          <label className="profile-cls-11">
            Assigned Role
          </label>
          <input 
            type="text" 
            value={(user?.role || 'student').toUpperCase().replace('_', ' ')}
            readOnly
            className="profile-cls-12"
            style={{ opacity: 0.8, cursor: 'not-allowed' }}
          />
        </div>

        {/* Action Button */}
        <div className="profile-cls-13">
          <button 
            type="submit" 
            disabled={saving} 
            className="profile-cls-14"
          >
            {saving ? 'Saving...' : 'Save changes'}
            <HiOutlineChevronRight className="profile-cls-15" />
          </button>
          {statusMsg && <p className="text-sm text-green-600 mt-3 font-medium" role="status">{statusMsg}</p>}
          {errorMsg && <p className="text-sm text-red-600 mt-3 font-medium" role="alert">{errorMsg}</p>}
          <p className="text-sm text-gray-500 mt-3">Profile details are stored persistently in the database.</p>
        </div>
      </form>
    </div>
  );
};
