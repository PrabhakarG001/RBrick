import React, { createContext, useContext, useState, useEffect } from 'react';
import { loginApi, registerApi, getMeApi, updateProfileApi, logoutApi } from '../services/api';

import { readBrandStorage, writeBrandStorage, clearBrandStorage } from '../services/brandStorage';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(readBrandStorage('token') || null);
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
            email: 'operator@rbrick.local',
            role: 'admin',
            company: 'RBrick',
          });
        }
      } else {
        // Default guest/demo user for instant access
        setUser({
          name: 'Building Occupant',
          email: '',
          role: 'student',
          company: 'RBrick',
        });
      }
      setLoading(false);
    };

    fetchCurrentUser();
  }, [token]);

  const login = async (credentials) => {
    const res = await loginApi(credentials);
    if (res.success && res.token) {
      writeBrandStorage('token', res.token);
      setToken(res.token);
      setUser(res.user);
    }
    return res;
  };

  const register = async (userData) => {
    const res = await registerApi(userData);
    if (res.success && res.token) {
      writeBrandStorage('token', res.token);
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
    clearBrandStorage('token');
    setToken(null);
    setUser({
      name: 'Building Occupant',
      email: '',
      role: 'student',
      company: 'RBrick',
    });
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, updateProfile, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
