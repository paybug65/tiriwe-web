// ============================================================================
// TIRIWE CORE - Shared JavaScript for all pages
// ============================================================================
// Load this on every page: <script src="js/tiriwe-core.js"></script>
//
// Provides:
//   - Supabase connection
//   - Authentication (login, signup, logout, session restore)
//   - Current user profile loading and caching
//   - Profile completeness check + redirect to settings
//   - Feedback lock check
//   - Shared navigation bar rendering
//   - Utility functions (location, formatting, etc.)
//
// Requires: Supabase JS loaded first via CDN
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
// ============================================================================

(function() {
    'use strict';

    // ========================================================================
    // 1. CONFIGURATION
    // ========================================================================

    const CONFIG = {
        SUPABASE_URL: 'https://mozbpccxzfcoswvxjuym.supabase.co',
        SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1vemJwY2N4emZjb3N3dnhqdXltIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mzc2OTI1OTgsImV4cCI6MjA1MzI2ODU5OH0.smSmIFOsTCXEiNBEFuHFm1039VGjMh-kMBqjSFSgrFo',

        // Pages
        PAGE_LANDING: 'index.html',
        PAGE_DASHBOARD: 'dashboard.html',
        PAGE_SETTINGS: 'settings.html',
        PAGE_SOS: 'sos.html',
        PAGE_INTERACTIONS: 'interactions.html',
        PAGE_PROFILE: 'profile.html',

        // Pages that don't require authentication
        PUBLIC_PAGES: ['index.html', ''],

        // Brand
        BRAND_NAME: 'Tiriwe',
        BRAND_TAGLINE: 'I exist because we exist',
        BRAND_GREEN: '#2E7D32',
        BRAND_GREEN_DARK: '#1B5E20',
        BRAND_ORANGE: '#FF9800',
    };

    // ========================================================================
    // 2. SUPABASE INITIALISATION
    // ========================================================================

    let sb = null;

    try {
        if (window.supabase && window.supabase.createClient) {
            sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
            console.log('✅ Tiriwe Core: Supabase connected');
        } else {
            console.error('❌ Tiriwe Core: Supabase library not loaded');
        }
    } catch (err) {
        console.error('❌ Tiriwe Core: Failed to initialise Supabase', err);
    }

    // ========================================================================
    // 3. CURRENT USER STATE
    // ========================================================================

    // Cached user data — available to all pages via Tiriwe.user
    let currentUser = null;       // public.users row
    let currentAuthUser = null;   // auth user (email, id, etc.)
    let isInitialised = false;
    let initPromise = null;

    /**
     * Load the current user's profile from public.users
     * Matches on auth_id from the Supabase auth session
     */
    async function loadUserProfile(authId) {
        if (!sb) return null;

        const { data, error } = await sb
            .from('users')
            .select('*')
            .eq('auth_id', authId)
            .is('deleted_at', null)
            .single();

        if (error) {
            console.error('❌ Failed to load user profile:', error.message);
            return null;
        }

        return data;
    }

    /**
     * Check if user's profile is complete enough to use the app.
     * First-time users get redirected to settings to fill in basics.
     *
     * "Complete" means they've at least:
     *   - Set a display name (auto-generated, so always present)
     *   - Visited settings at least once (checked via metadata flag)
     *   - OR have set home_location (indicates they've configured basics)
     */
    function isProfileComplete(user) {
        if (!user) return false;

        // Check if they've completed initial setup
        // The metadata flag 'setup_complete' is set when they save settings for first time
        if (user.metadata && user.metadata.setup_complete) {
            return true;
        }

        // Fallback: if they have a home location, they've clearly configured things
        if (user.home_location) {
            return true;
        }

        return false;
    }

    /**
     * Check if user has overdue feedback that should lock the app.
     * Calls the check_feedback_lock database function.
     */
    async function checkFeedbackLock(userId) {
        if (!sb) return false;

        try {
            const { data, error } = await sb.rpc('check_feedback_lock', {
                check_user_id: userId
            });

            if (error) {
                // Function may not exist yet (pre-migration 005)
                console.warn('⚠️ Feedback lock check unavailable:', error.message);
                return false;
            }

            return data === true;
        } catch (err) {
            console.warn('⚠️ Feedback lock check failed:', err);
            return false;
        }
    }

    /**
     * Get pending feedback items for current user.
     * Returns array of interactions needing feedback.
     */
    async function getPendingFeedback(userId) {
        if (!sb) return [];

        try {
            const { data, error } = await sb.rpc('get_pending_feedback', {
                check_user_id: userId
            });

            if (error) {
                console.warn('⚠️ Pending feedback check unavailable:', error.message);
                return [];
            }

            return data || [];
        } catch (err) {
            console.warn('⚠️ Pending feedback check failed:', err);
            return [];
        }
    }

    // ========================================================================
    // 4. AUTHENTICATION
    // ========================================================================

    /**
     * Sign up a new user with email and password.
     * The handle_new_user trigger creates the public.users record.
     */
    async function signUp(email, password) {
        if (!sb) return { error: { message: 'Supabase not connected' } };

        const { data, error } = await sb.auth.signUp({
            email: email,
            password: password
        });

        if (error) {
            console.error('❌ Signup failed:', error.message);
            return { data: null, error };
        }

        console.log('✅ Signup successful:', email);
        return { data, error: null };
    }

    /**
     * Log in with email and password.
     * After login, loads user profile and checks completeness.
     */
    async function logIn(email, password) {
        if (!sb) return { error: { message: 'Supabase not connected' } };

        const { data, error } = await sb.auth.signInWithPassword({
            email: email,
            password: password
        });

        if (error) {
            console.error('❌ Login failed:', error.message);
            return { data: null, error };
        }

        // Load profile
        currentAuthUser = data.user;
        currentUser = await loadUserProfile(data.user.id);

        console.log('✅ Login successful:', currentUser?.display_name || email);

        // Update last_active_at
        if (currentUser) {
            await sb.from('users')
                .update({ last_active_at: new Date().toISOString() })
                .eq('id', currentUser.id);
        }

        return { data, error: null, user: currentUser };
    }

    /**
     * Log out the current user.
     */
    async function logOut() {
        if (!sb) return;

        await sb.auth.signOut();
        currentUser = null;
        currentAuthUser = null;
        console.log('✅ Logged out');

        // Redirect to landing page
        navigateTo(CONFIG.PAGE_LANDING);
    }

    /**
     * Request a password reset email.
     */
    async function resetPassword(email) {
        if (!sb) return { error: { message: 'Supabase not connected' } };

        const { data, error } = await sb.auth.resetPasswordForEmail(email);
        return { data, error };
    }

    // ========================================================================
    // 5. SESSION MANAGEMENT & INITIALISATION
    // ========================================================================

    /**
     * Initialise the core — called automatically on page load.
     * Checks for existing session, loads user, and handles routing.
     *
     * Returns a promise that resolves when init is complete.
     * Other code can await Tiriwe.ready() to wait for this.
     */
    async function init() {
        if (isInitialised) return;

        const currentPage = getCurrentPage();
        const isPublicPage = CONFIG.PUBLIC_PAGES.includes(currentPage);

        // Check for existing session
        if (sb) {
            try {
                const { data: { session } } = await sb.auth.getSession();

                if (session && session.user) {
                    currentAuthUser = session.user;
                    currentUser = await loadUserProfile(session.user.id);

                    if (currentUser) {
                        console.log('✅ Session restored:', currentUser.display_name);

                        // Update last_active_at
                        await sb.from('users')
                            .update({ last_active_at: new Date().toISOString() })
                            .eq('id', currentUser.id);

                        // If on landing page and logged in, redirect to dashboard
                        if (isPublicPage) {
                            if (!isProfileComplete(currentUser)) {
                                navigateTo(CONFIG.PAGE_SETTINGS);
                                return;
                            } else {
                                navigateTo(CONFIG.PAGE_DASHBOARD);
                                return;
                            }
                        }

                        // If on protected page, check profile completeness
                        if (!isPublicPage && currentPage !== CONFIG.PAGE_SETTINGS) {
                            if (!isProfileComplete(currentUser)) {
                                navigateTo(CONFIG.PAGE_SETTINGS);
                                return;
                            }
                        }

                        // Render nav on protected pages
                        if (!isPublicPage) {
                            renderNav();
                        }

                    } else {
                        console.warn('⚠️ Auth session exists but no user profile found');
                        // Auth record exists but public.users row is missing
                        // This can happen if the trigger failed
                        if (!isPublicPage) {
                            navigateTo(CONFIG.PAGE_LANDING);
                            return;
                        }
                    }
                } else {
                    // No session — redirect to landing if on protected page
                    if (!isPublicPage) {
                        console.log('🔒 No session, redirecting to login');
                        navigateTo(CONFIG.PAGE_LANDING);
                        return;
                    }
                }
            } catch (err) {
                console.error('❌ Session check failed:', err);
                if (!isPublicPage) {
                    navigateTo(CONFIG.PAGE_LANDING);
                    return;
                }
            }
        }

        isInitialised = true;

        // Fire custom event so page-specific JS knows core is ready
        window.dispatchEvent(new CustomEvent('tiriwe:ready', {
            detail: { user: currentUser, authUser: currentAuthUser }
        }));
    }

    // ========================================================================
    // 6. NAVIGATION
    // ========================================================================

    /**
     * Get current page filename from URL
     */
    function getCurrentPage() {
        const path = window.location.pathname;
        const filename = path.substring(path.lastIndexOf('/') + 1);
        return filename || '';
    }

    /**
     * Navigate to a page
     */
    function navigateTo(page) {
        window.location.href = page;
    }

    /**
     * Render the shared navigation bar on protected pages.
     * Looks for a <nav id="tiriwe-nav"></nav> element on the page.
     * If not found, creates one at the top of the body.
     */
    function renderNav() {
        let navEl = document.getElementById('tiriwe-nav');

        if (!navEl) {
            navEl = document.createElement('nav');
            navEl.id = 'tiriwe-nav';
            document.body.insertBefore(navEl, document.body.firstChild);
        }

        const currentPage = getCurrentPage();
        const user = currentUser;
        const avatarEmoji = user?.avatar_emoji || '👤';
        const displayName = user?.display_name || 'User';

        navEl.innerHTML = `
            <div class="tiriwe-nav-inner">
                <a href="${CONFIG.PAGE_DASHBOARD}" class="tiriwe-nav-brand">
                    <span class="tiriwe-nav-dot"></span>
                    ${CONFIG.BRAND_NAME}
                </a>
                <div class="tiriwe-nav-links">
                    <a href="${CONFIG.PAGE_DASHBOARD}" class="tiriwe-nav-link ${currentPage === CONFIG.PAGE_DASHBOARD ? 'active' : ''}">
                        🏠 Dashboard
                    </a>
                    <a href="${CONFIG.PAGE_SOS}" class="tiriwe-nav-link ${currentPage === CONFIG.PAGE_SOS ? 'active' : ''}">
                        🚨 SOS
                    </a>
                    <a href="${CONFIG.PAGE_INTERACTIONS}" class="tiriwe-nav-link ${currentPage === CONFIG.PAGE_INTERACTIONS ? 'active' : ''}">
                        🤝 Interactions
                    </a>
                </div>
                <div class="tiriwe-nav-user">
                    <a href="${CONFIG.PAGE_PROFILE}" class="tiriwe-nav-profile ${currentPage === CONFIG.PAGE_PROFILE ? 'active' : ''}">
                        <span class="tiriwe-nav-avatar">${avatarEmoji}</span>
                        <span class="tiriwe-nav-name">${displayName}</span>
                    </a>
                    <a href="${CONFIG.PAGE_SETTINGS}" class="tiriwe-nav-settings ${currentPage === CONFIG.PAGE_SETTINGS ? 'active' : ''}" title="Settings">
                        ⚙️
                    </a>
                    <button class="tiriwe-nav-logout" onclick="Tiriwe.logOut()" title="Log out">
                        ↪
                    </button>
                </div>
            </div>
        `;

        // Inject nav styles if not already present
        if (!document.getElementById('tiriwe-nav-styles')) {
            const style = document.createElement('style');
            style.id = 'tiriwe-nav-styles';
            style.textContent = `
                #tiriwe-nav {
                    position: fixed; top: 0; left: 0; right: 0; z-index: 1000;
                    background: rgba(255,255,255,0.95); backdrop-filter: blur(10px);
                    border-bottom: 1px solid #e0e0e0;
                    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
                }
                .tiriwe-nav-inner {
                    max-width: 1200px; margin: 0 auto; padding: 0 24px;
                    display: flex; align-items: center; justify-content: space-between;
                    height: 60px;
                }
                .tiriwe-nav-brand {
                    font-size: 22px; font-weight: 800; color: ${CONFIG.BRAND_GREEN_DARK};
                    text-decoration: none; display: flex; align-items: center; gap: 8px;
                }
                .tiriwe-nav-dot {
                    width: 10px; height: 10px; background: ${CONFIG.BRAND_GREEN};
                    border-radius: 50%; display: inline-block;
                }
                .tiriwe-nav-links {
                    display: flex; gap: 4px;
                }
                .tiriwe-nav-link {
                    padding: 8px 16px; border-radius: 8px; text-decoration: none;
                    font-size: 14px; font-weight: 500; color: #4a4a4a;
                    transition: all 0.2s;
                }
                .tiriwe-nav-link:hover { background: #E8F5E9; color: #1a1a1a; }
                .tiriwe-nav-link.active { background: #E8F5E9; color: ${CONFIG.BRAND_GREEN}; font-weight: 600; }
                .tiriwe-nav-user {
                    display: flex; align-items: center; gap: 8px;
                }
                .tiriwe-nav-profile {
                    display: flex; align-items: center; gap: 8px; padding: 6px 12px;
                    border-radius: 8px; text-decoration: none; color: #1a1a1a;
                    transition: all 0.2s;
                }
                .tiriwe-nav-profile:hover, .tiriwe-nav-profile.active { background: #E8F5E9; }
                .tiriwe-nav-avatar {
                    width: 32px; height: 32px; border-radius: 50%;
                    background: #E8F5E9; display: flex; align-items: center;
                    justify-content: center; font-size: 18px;
                }
                .tiriwe-nav-name { font-size: 14px; font-weight: 600; }
                .tiriwe-nav-settings {
                    padding: 6px 10px; border-radius: 8px; text-decoration: none;
                    font-size: 18px; transition: all 0.2s;
                }
                .tiriwe-nav-settings:hover, .tiriwe-nav-settings.active { background: #E8F5E9; }
                .tiriwe-nav-logout {
                    padding: 6px 10px; border-radius: 8px; border: none;
                    background: transparent; cursor: pointer; font-size: 16px;
                    color: #999; transition: all 0.2s;
                }
                .tiriwe-nav-logout:hover { background: #FFF0F0; color: #F44336; }

                /* Push page content below fixed nav */
                body { padding-top: 60px; }

                /* Responsive */
                @media (max-width: 768px) {
                    .tiriwe-nav-links { display: none; }
                    .tiriwe-nav-name { display: none; }
                }
            `;
            document.head.appendChild(style);
        }
    }

    // ========================================================================
    // 7. FEEDBACK LOCK BANNER
    // ========================================================================

    /**
     * Check for pending feedback and show banner if needed.
     * Call this after init on protected pages.
     */
    async function checkAndShowFeedbackBanner() {
        if (!currentUser) return;

        const isLocked = await checkFeedbackLock(currentUser.id);
        const pending = await getPendingFeedback(currentUser.id);

        if (pending.length === 0) return;

        // Create banner
        let banner = document.getElementById('tiriwe-feedback-banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'tiriwe-feedback-banner';
            document.body.insertBefore(banner, document.body.firstChild.nextSibling);
        }

        if (isLocked) {
            // Hard lock — grace period expired
            banner.innerHTML = `
                <div class="tiriwe-fb-banner locked">
                    🔒 <strong>Feedback required.</strong> Complete your pending feedback to continue using Tiriwe.
                    <a href="${CONFIG.PAGE_INTERACTIONS}">Give Feedback Now</a>
                </div>
            `;
        } else {
            // Soft reminder — grace period active
            const soonest = pending[0];
            const expiresAt = soonest.grace_expires_at ? new Date(soonest.grace_expires_at) : null;
            const timeLeft = expiresAt ? formatTimeRemaining(expiresAt) : '';

            banner.innerHTML = `
                <div class="tiriwe-fb-banner reminder">
                    ⏰ <strong>Feedback pending</strong>${timeLeft ? ' — ' + timeLeft + ' remaining' : ''}.
                    <a href="${CONFIG.PAGE_INTERACTIONS}">Give Feedback</a>
                </div>
            `;
        }

        // Inject banner styles
        if (!document.getElementById('tiriwe-fb-banner-styles')) {
            const style = document.createElement('style');
            style.id = 'tiriwe-fb-banner-styles';
            style.textContent = `
                .tiriwe-fb-banner {
                    padding: 10px 24px; text-align: center;
                    font-size: 14px; font-weight: 500;
                    font-family: 'Inter', -apple-system, sans-serif;
                }
                .tiriwe-fb-banner a {
                    margin-left: 12px; font-weight: 700; text-decoration: underline;
                }
                .tiriwe-fb-banner.reminder {
                    background: #FFF3E0; color: #E65100; border-bottom: 1px solid #FFE0B2;
                }
                .tiriwe-fb-banner.reminder a { color: #E65100; }
                .tiriwe-fb-banner.locked {
                    background: #FFEBEE; color: #C62828; border-bottom: 1px solid #FFCDD2;
                }
                .tiriwe-fb-banner.locked a { color: #C62828; }
            `;
            document.head.appendChild(style);
        }
    }

    // ========================================================================
    // 8. UTILITY FUNCTIONS
    // ========================================================================

    /**
     * Format a future date as "Xh Ym remaining"
     */
    function formatTimeRemaining(futureDate) {
        const now = new Date();
        const diff = futureDate - now;
        if (diff <= 0) return 'expired';

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

        if (hours > 24) {
            const days = Math.floor(hours / 24);
            return `${days}d ${hours % 24}h`;
        }
        return `${hours}h ${minutes}m`;
    }

    /**
     * Format a date for display
     */
    function formatDate(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        return d.toLocaleDateString('en-NZ', {
            day: 'numeric', month: 'short', year: 'numeric'
        });
    }

    /**
     * Format a date with time
     */
    function formatDateTime(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        return d.toLocaleDateString('en-NZ', {
            day: 'numeric', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    }

    /**
     * Format distance in km
     */
    function formatDistance(km) {
        if (km < 1) return `${Math.round(km * 1000)}m`;
        if (km < 10) return `${km.toFixed(1)}km`;
        return `${Math.round(km)}km`;
    }

    /**
     * Get verification level display info
     */
    function getVerificationInfo(level) {
        const levels = {
            'unverified':       { name: 'Unverified',        icon: '👤', color: '#9E9E9E' },
            'photo_added':      { name: 'Photo Added',       icon: '📷', color: '#42A5F5' },
            'verified_once':    { name: 'Verified x1',       icon: '✓',  color: '#66BB6A' },
            'verified_twice':   { name: 'Verified x2',       icon: '✓✓', color: '#43A047' },
            'community_verified': { name: 'Community Verified', icon: '★', color: '#2E7D32' }
        };
        return levels[level] || levels['unverified'];
    }

    /**
     * Show a toast notification
     */
    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `tiriwe-toast tiriwe-toast-${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        // Inject toast styles once
        if (!document.getElementById('tiriwe-toast-styles')) {
            const style = document.createElement('style');
            style.id = 'tiriwe-toast-styles';
            style.textContent = `
                .tiriwe-toast {
                    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
                    padding: 12px 24px; border-radius: 8px; font-size: 14px;
                    font-weight: 500; z-index: 9999; animation: tiriweToastIn 0.3s ease;
                    font-family: 'Inter', -apple-system, sans-serif;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                }
                .tiriwe-toast-info { background: #1e293b; color: white; }
                .tiriwe-toast-success { background: #2E7D32; color: white; }
                .tiriwe-toast-error { background: #C62828; color: white; }
                .tiriwe-toast-warning { background: #E65100; color: white; }
                @keyframes tiriweToastIn { from { opacity: 0; transform: translateX(-50%) translateY(20px); } }
            `;
            document.head.appendChild(style);
        }

        // Auto-remove after 4 seconds
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    /**
     * Get the user's current GPS location
     * Returns a promise with { latitude, longitude } or null
     */
    function getCurrentLocation() {
        return new Promise((resolve) => {
            if (!navigator.geolocation) {
                console.warn('⚠️ Geolocation not supported');
                resolve(null);
                return;
            }

            navigator.geolocation.getCurrentPosition(
                (position) => {
                    resolve({
                        latitude: position.coords.latitude,
                        longitude: position.coords.longitude,
                        accuracy: position.coords.accuracy
                    });
                },
                (error) => {
                    console.warn('⚠️ Geolocation error:', error.message);
                    resolve(null);
                },
                { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
            );
        });
    }

    // ========================================================================
    // 9. PUBLIC API
    // ========================================================================

    // Expose everything pages need via the global Tiriwe object
    window.Tiriwe = {
        // State
        get user() { return currentUser; },
        get authUser() { return currentAuthUser; },
        get sb() { return sb; },
        get config() { return CONFIG; },

        // Auth
        signUp,
        logIn,
        logOut,
        resetPassword,

        // Profile
        loadUserProfile,
        isProfileComplete,

        // Feedback
        checkFeedbackLock,
        getPendingFeedback,
        checkAndShowFeedbackBanner,

        // Navigation
        renderNav,
        navigateTo,
        getCurrentPage,

        // Utilities
        formatDate,
        formatDateTime,
        formatDistance,
        formatTimeRemaining,
        getVerificationInfo,
        getCurrentLocation,
        showToast,

        /**
         * Returns a promise that resolves when Tiriwe core is initialised.
         * Use in page-specific JS:
         *
         *   Tiriwe.ready().then(() => {
         *       const user = Tiriwe.user;
         *       // page-specific setup
         *   });
         *
         * Or with async/await:
         *
         *   await Tiriwe.ready();
         *   const user = Tiriwe.user;
         */
        ready() {
            if (isInitialised) return Promise.resolve();
            return initPromise;
        }
    };

    // ========================================================================
    // 10. AUTO-INITIALISE
    // ========================================================================

    // Start init when DOM is ready
    if (document.readyState === 'loading') {
        initPromise = new Promise((resolve) => {
            document.addEventListener('DOMContentLoaded', () => {
                init().then(resolve);
            });
        });
    } else {
        initPromise = init();
    }

})();
