import React, { createContext, useContext, useState, useEffect } from 'react';
import { loginApi, registerApi, getMeApi, updateProfileApi, logoutApi } from '../services/api';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('ravynx_token') || localStorage.getItem('resilliox_token') || null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchCurrentUser = async () => {
      if (token) {
        try {
          const res = await getMeApi();
          if (res.success && res.user) {
            setUser(res.user);
          }
        } catch (err) {
          console.warn('[AuthContext] Session expired or server unavailable:', err.message);
          // Keep demo state
          setUser({
            name: 'Building Operator',
            email: 'operator@resilliox.local',
            role: 'admin',
            company: 'ResillioX',
          });
        }
      } else {
        // Default guest/demo user for instant access
        setUser({
          name: 'Building Occupant',
          email: '',
          role: 'student',
          company: 'ResillioX',
        });
      }
      setLoading(false);
    };

    fetchCurrentUser();
  }, [token]);

  const login = async (credentials) => {
    const res = await loginApi(credentials);
    if (res.success && res.token) {
      localStorage.setItem('ravynx_token', res.token);
      localStorage.setItem('resilliox_token', res.token);
      setToken(res.token);
      setUser(res.user);
    }
    return res;
  };

  const register = async (userData) => {
    const res = await registerApi(userData);
    if (res.success && res.token) {
      localStorage.setItem('ravynx_token', res.token);
      localStorage.setItem('resilliox_token', res.token);
      setToken(res.token);
      setUser(res.user);
    }
    return res;
  };

  const updateProfile = async (profileData) => {
    const res = await updateProfileApi(profileData);
    if (res.success && res.user) {
      setUser(prev => ({ ...prev, ...res.user }));
    }
    return res;
  };

  const logout = () => {
    try { logoutApi(); } catch {}
    localStorage.removeItem('ravynx_token');
    localStorage.removeItem('resilliox_token');
    setToken(null);
    setUser({
      name: 'Building Occupant',
      email: '',
      role: 'student',
      company: 'ResillioX',
    });
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, updateProfile, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
