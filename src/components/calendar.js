/**
 * ============================================================================
 * MONTE AZUR — CALENDAR & BOOKING CONTROLLER (src/components/calendar.js)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Calendar State & Zero-Reflow DocumentFragment Grid)
 * - STAGE 2: CORE FUNCTIONALITY (Delegated Event Handling, Date Validation & Quote UI)
 * - STAGE 3: ENHANCEMENT / ANIMATION / OPTIMIZATION (Accessible Inquiry Modal & Stripe Flow)
 *
 * WHY THIS MODULE EXISTS:
 * Unifies `CalendarEngine` and `BookingController` into a single modular component
 * connected to `BookingAPI` (`src/api/booking.js`).
 *
 * TRICKY LOGIC:
 * 1. Replaces 35+ sequential `elGrid.appendChild()` calls and 70+ individual button
 *    closures per month render with an off-DOM `DocumentFragment` (`replaceChildren`)
 *    and a single delegated `click` + `mouseover` listener on `#calendar-grid`.
 * 2. Preserves WCAG 2.4.3 focus trapping and Escape-key dismissal inside `#inquiry-modal`.
 *
 * TODO:
 * - Add multi-currency display toggle (USD / EUR / GBP) in the quote breakdown.
 * ============================================================================
 */

import {
  BookingAPI,
  fetchUnavailableDates,
  startBookingCheckout,
  DEFAULT_PROPERTY_ID,
} from '../api/booking.js';
import { stopScroll, startScroll } from '../animations/lenis.js';

// ============================================================================
// STAGE 1: FOUNDATION CODE — Calendar State & DocumentFragment Grid Builder
// ============================================================================
// STEP 1: Create the HTML structure (#calendar-grid, #cal-month-year, #cal-prev, #cal-next)
// STEP 2: Add the CSS layout and styling (.calendar-day, .calendar-day--selected, --in-range)
// STEP 3: Initialize state and delegated DOM listeners

export const CalendarEngine = (() => {
  let displayYear = new Date().getFullYear();
  let displayMonth = new Date().getMonth();
  let checkInDate = null;
  let checkOutDate = null;
  let hoveredDate = null;
  let onSelectionChangeCallback = null;

  let elGrid = null;
  let elMonthYear = null;
  let elPrevBtn = null;
  let elNextBtn = null;

  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

  const getDaysInMonth = (year, month) => {
    const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return days[month];
  };

  const formatDateKey = (date) => BookingAPI.formatDateKey(date);

  const parseDateKey = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  };

  const compareDates = (d1, d2) => {
    const t1 = new Date(d1.getFullYear(), d1.getMonth(), d1.getDate()).getTime();
    const t2 = new Date(d2.getFullYear(), d2.getMonth(), d2.getDate()).getTime();
    if (t1 < t2) return -1;
    if (t1 > t2) return 1;
    return 0;
  };

  const init = (gridId, monthYearId, prevBtnId, nextBtnId, onSelectionChange) => {
    elGrid = document.getElementById(gridId);
    elMonthYear = document.getElementById(monthYearId);
    elPrevBtn = document.getElementById(prevBtnId);
    elNextBtn = document.getElementById(nextBtnId);
    onSelectionChangeCallback = onSelectionChange;

    if (!elGrid || !elMonthYear || !elPrevBtn || !elNextBtn) return;

    elPrevBtn.addEventListener('click', handlePrevMonth);
    elNextBtn.addEventListener('click', handleNextMonth);

    // Delegated click listener on #calendar-grid (zero per-cell closures)
    elGrid.addEventListener('click', (e) => {
      const btn = e.target.closest('.calendar-day--available[data-date]');
      if (!btn || btn.disabled) return;
      const dateKey = btn.getAttribute('data-date');
      if (dateKey) {
        handleDateClick(parseDateKey(dateKey));
      }
    });

    // Delegated hover preview listener on #calendar-grid
    elGrid.addEventListener('mouseover', (e) => {
      if (!checkInDate || checkOutDate) return;
      const btn = e.target.closest('.calendar-day--available[data-date]');
      if (!btn || btn.disabled) return;
      const dateKey = btn.getAttribute('data-date');
      if (dateKey) {
        handleDateHover(parseDateKey(dateKey));
      }
    });

    render();
  };

  const loadMonthAvailability = async () => {
    try {
      const monthStr = `${displayYear}-${String(displayMonth + 1).padStart(2, '0')}`;
      await fetchUnavailableDates(DEFAULT_PROPERTY_ID, monthStr);
      render();
    } catch (err) {
      console.warn('[Calendar] Failed to load month availability:', err);
    }
  };

  const handlePrevMonth = async () => {
    const today = new Date();
    if (displayYear === today.getFullYear() && displayMonth === today.getMonth()) {
      return;
    }
    displayMonth -= 1;
    if (displayMonth < 0) {
      displayMonth = 11;
      displayYear -= 1;
    }
    render();
    await loadMonthAvailability();
  };

  const handleNextMonth = async () => {
    displayMonth += 1;
    if (displayMonth > 11) {
      displayMonth = 0;
      displayYear += 1;
    }
    render();
    await loadMonthAvailability();
  };

  /**
   * Builds the month grid inside an off-DOM `DocumentFragment` and commits
   * in a single DOM mutation via `replaceChildren(fragment)`.
   */
  const render = () => {
    if (!elGrid || !elMonthYear) return;

    elMonthYear.textContent = `${MONTH_NAMES[displayMonth]} ${displayYear}`;

    const today = new Date();
    const isCurrentMonth =
      displayYear === today.getFullYear() && displayMonth === today.getMonth();
    elPrevBtn.disabled = isCurrentMonth;
    elPrevBtn.style.opacity = isCurrentMonth ? '0.3' : '1';
    elPrevBtn.style.cursor = isCurrentMonth ? 'not-allowed' : 'pointer';

    const firstDayIndex = new Date(displayYear, displayMonth, 1).getDay();
    const totalDays = getDaysInMonth(displayYear, displayMonth);
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < firstDayIndex; i++) {
      const emptyCell = document.createElement('div');
      emptyCell.className = 'calendar-day calendar-day--empty is-disabled';
      emptyCell.setAttribute('aria-hidden', 'true');
      fragment.appendChild(emptyCell);
    }

    for (let day = 1; day <= totalDays; day++) {
      const cellDate = new Date(displayYear, displayMonth, day);
      const dateKey = formatDateKey(cellDate);
      const dayCell = document.createElement('button');
      dayCell.type = 'button';
      dayCell.className = 'calendar-day';
      dayCell.textContent = String(day);
      dayCell.setAttribute('data-date', dateKey);
      dayCell.setAttribute('aria-label', `${MONTH_NAMES[displayMonth]} ${day}, ${displayYear}`);

      if (compareDates(cellDate, today) === 0) {
        dayCell.classList.add('calendar-day--today');
      }

      if (compareDates(cellDate, today) < 0) {
        dayCell.classList.add('calendar-day--disabled', 'is-disabled');
        dayCell.disabled = true;
        fragment.appendChild(dayCell);
        continue;
      }

      const isAvailable = BookingAPI.isDateAvailable(dateKey);
      if (!isAvailable) {
        dayCell.classList.add('calendar-day--booked', 'is-disabled');
        dayCell.disabled = true;
        dayCell.setAttribute('aria-disabled', 'true');
        fragment.appendChild(dayCell);
        continue;
      }

      dayCell.classList.add('calendar-day--available');

      if (checkInDate && compareDates(cellDate, checkInDate) === 0) {
        dayCell.classList.add('calendar-day--selected', 'calendar-day--range-start');
        dayCell.setAttribute('aria-selected', 'true');
      }

      if (checkOutDate && compareDates(cellDate, checkOutDate) === 0) {
        dayCell.classList.add('calendar-day--selected', 'calendar-day--range-end');
        dayCell.setAttribute('aria-selected', 'true');
      }

      if (checkInDate && checkOutDate) {
        if (compareDates(cellDate, checkInDate) > 0 && compareDates(cellDate, checkOutDate) < 0) {
          dayCell.classList.add('calendar-day--in-range');
        }
      } else if (checkInDate && hoveredDate) {
        if (compareDates(cellDate, checkInDate) > 0 && compareDates(cellDate, hoveredDate) <= 0) {
          dayCell.classList.add('calendar-day--in-range');
        }
      }

      fragment.appendChild(dayCell);
    }

    elGrid.replaceChildren(fragment);
  };

  const handleDateClick = (clickedDate) => {
    if (!checkInDate || (checkInDate && checkOutDate)) {
      checkInDate = clickedDate;
      checkOutDate = null;
      hoveredDate = null;
    } else if (checkInDate && !checkOutDate) {
      if (compareDates(clickedDate, checkInDate) <= 0) {
        checkInDate = clickedDate;
        checkOutDate = null;
      } else {
        const startKey = formatDateKey(checkInDate);
        const endKey = formatDateKey(clickedDate);

        if (BookingAPI.isRangeAvailable(startKey, endKey)) {
          checkOutDate = clickedDate;
        } else {
          checkInDate = clickedDate;
          checkOutDate = null;
        }
      }
    }

    render();

    if (onSelectionChangeCallback) {
      onSelectionChangeCallback(checkInDate, checkOutDate);
    }
  };

  const handleDateHover = (hoverDate) => {
    if (checkInDate && !checkOutDate && compareDates(hoverDate, checkInDate) > 0) {
      hoveredDate = hoverDate;
      renderRangePreview();
    }
  };

  const renderRangePreview = () => {
    if (!elGrid || !checkInDate || !hoveredDate) return;
    const cells = elGrid.querySelectorAll('.calendar-day--available');
    cells.forEach((cell) => {
      const cellDateKey = cell.getAttribute('data-date');
      if (!cellDateKey) return;
      const cellDate = parseDateKey(cellDateKey);

      if (compareDates(cellDate, checkInDate) > 0 && compareDates(cellDate, hoveredDate) <= 0) {
        cell.classList.add('calendar-day--in-range');
      } else if (!checkOutDate) {
        cell.classList.remove('calendar-day--in-range');
      }
    });
  };

  const resetSelection = () => {
    checkInDate = null;
    checkOutDate = null;
    hoveredDate = null;
    render();
    if (onSelectionChangeCallback) {
      onSelectionChangeCallback(null, null);
    }
  };

  return {
    init,
    resetSelection,
    getDates: () => ({ checkIn: checkInDate, checkOut: checkOutDate }),
    formatDateKey,
  };
})();

// ============================================================================
// STAGE 2 & 3: CORE FUNCTIONALITY & CHECKOUT MODAL — BookingController
// ============================================================================
// STEP 4: Connect live pricing breakdown to calendar state
// STEP 5: Handle reservation submission via BookingAPI.createCheckoutSession()

export const BookingController = (() => {
  let adults = 2;
  let children = 0;
  let currentQuote = null;
  let activeReservation = null;
  let lastFocusedTrigger = null;

  const dom = {};

  const init = async () => {
    cacheDom();
    bindEvents();

    await BookingAPI.fetchAvailability();

    CalendarEngine.init(
      'calendar-grid',
      'cal-month-year',
      'cal-prev',
      'cal-next',
      handleDatesChanged
    );

    updateGuestCountersUI();
  };

  const cacheDom = () => {
    dom.previewCheckin = document.getElementById('preview-checkin');
    dom.previewCheckout = document.getElementById('preview-checkout');

    dom.adultsCount = document.getElementById('adults-count');
    dom.adultsDec = document.getElementById('adults-dec');
    dom.adultsInc = document.getElementById('adults-inc');

    dom.childrenCount = document.getElementById('children-count');
    dom.childrenDec = document.getElementById('children-dec');
    dom.childrenInc = document.getElementById('children-inc');

    dom.priceBreakdown = document.getElementById('price-breakdown');
    dom.rateLine = document.getElementById('rate-line');
    dom.nightsCount = document.getElementById('nights-count');
    dom.subtotalVal = document.getElementById('subtotal-val');
    dom.serviceFeeVal = document.getElementById('service-fee-val');
    dom.totalVal = document.getElementById('total-val');
    dom.statusNotice = document.getElementById('booking-status-notice');
    dom.btnOpenInquiry = document.getElementById('btn-open-inquiry');
    dom.btnResetDates = document.getElementById('btn-reset-dates');

    dom.inquiryModal = document.getElementById('inquiry-modal');
    dom.modalHeader = document.getElementById('inquiry-header');
    dom.inquiryBackdrop = document.getElementById('inquiry-backdrop');
    dom.inquiryClose = document.getElementById('inquiry-close');
    dom.inquiryCancel = document.getElementById('inquiry-cancel');
    dom.inquirySummary = document.getElementById('inquiry-summary');
    dom.inquiryForm = document.getElementById('inquiry-form');
    dom.formFeedback = document.getElementById('form-feedback');
    dom.inquirySuccess = document.getElementById('inquiry-success');
    dom.inquiryFinish = document.getElementById('inquiry-finish');

    dom.modalSummaryDates = document.getElementById('modal-summary-dates');
    dom.modalSummaryNights = document.getElementById('modal-summary-nights');
    dom.modalSummaryGuests = document.getElementById('modal-summary-guests');
    dom.modalSummaryPrice = document.getElementById('modal-summary-price');
    dom.successReferenceId = document.getElementById('success-reference-id');
    dom.successGuestName = document.getElementById('success-guest-name');
    dom.successDates = document.getElementById('success-dates');
    dom.successNights = document.getElementById('success-nights');
    dom.successGuests = document.getElementById('success-guests');
    dom.successPrice = document.getElementById('success-price');
    dom.successPayment = document.getElementById('success-payment');
  };

  const bindEvents = () => {
    // Payment method selector toggle (Credit Card vs GCash placeholder)
    const paymentRadios = document.querySelectorAll('input[name="payment_method"]');
    const labelCard = document.getElementById('label-method-card');
    const labelGcash = document.getElementById('label-method-gcash');
    const fieldsCard = document.getElementById('mock-fields-card');
    const fieldsGcash = document.getElementById('mock-fields-gcash');

    paymentRadios.forEach((radio) => {
      radio.addEventListener('change', () => {
        if (radio.value === 'credit_card' && radio.checked) {
          if (labelCard) labelCard.classList.add('payment-mock__option--active');
          if (labelGcash) labelGcash.classList.remove('payment-mock__option--active');
          if (fieldsCard) fieldsCard.hidden = false;
          if (fieldsGcash) fieldsGcash.hidden = true;
        } else if (radio.value === 'gcash' && radio.checked) {
          if (labelCard) labelCard.classList.remove('payment-mock__option--active');
          if (labelGcash) labelGcash.classList.add('payment-mock__option--active');
          if (fieldsCard) fieldsCard.hidden = true;
          if (fieldsGcash) fieldsGcash.hidden = false;
        }
      });
    });
    if (dom.adultsDec) dom.adultsDec.addEventListener('click', () => adjustGuests('adults', -1));
    if (dom.adultsInc) dom.adultsInc.addEventListener('click', () => adjustGuests('adults', 1));
    if (dom.childrenDec) dom.childrenDec.addEventListener('click', () => adjustGuests('children', -1));
    if (dom.childrenInc) dom.childrenInc.addEventListener('click', () => adjustGuests('children', 1));

    if (dom.btnOpenInquiry) dom.btnOpenInquiry.addEventListener('click', openInquiryModal);
    if (dom.btnResetDates) {
      dom.btnResetDates.addEventListener('click', () => CalendarEngine.resetSelection());
    }
    if (dom.inquiryClose) dom.inquiryClose.addEventListener('click', closeInquiryModal);
    if (dom.inquiryCancel) dom.inquiryCancel.addEventListener('click', closeInquiryModal);
    if (dom.inquiryBackdrop) dom.inquiryBackdrop.addEventListener('click', closeInquiryModal);
    if (dom.inquiryFinish) dom.inquiryFinish.addEventListener('click', closeInquiryModal);

    if (dom.inquiryForm) {
      dom.inquiryForm.addEventListener('submit', handleInquirySubmit);
    }

    document.addEventListener('keydown', (e) => {
      if (!dom.inquiryModal || dom.inquiryModal.hidden) return;

      if (e.key === 'Escape') {
        closeInquiryModal();
      } else if (e.key === 'Tab') {
        const focusable = dom.inquiryModal.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const visibleElements = Array.from(focusable).filter(
          (el) => !el.disabled && el.offsetParent !== null
        );
        if (!visibleElements.length) return;

        const firstEl = visibleElements[0];
        const lastEl = visibleElements[visibleElements.length - 1];

        if (e.shiftKey && document.activeElement === firstEl) {
          lastEl.focus();
          e.preventDefault();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          firstEl.focus();
          e.preventDefault();
        }
      }
    });
  };

  const adjustGuests = (type, delta) => {
    const maxCapacity = BookingAPI.getMaxGuests();

    if (type === 'adults') {
      const next = adults + delta;
      if (next >= 1 && next + children <= maxCapacity) {
        adults = next;
      }
    } else if (type === 'children') {
      const next = children + delta;
      if (next >= 0 && adults + next <= maxCapacity) {
        children = next;
      }
    }

    updateGuestCountersUI();
    recalculateQuote();
  };

  const updateGuestCountersUI = () => {
    const maxCapacity = BookingAPI.getMaxGuests();
    const total = adults + children;

    if (dom.adultsCount) dom.adultsCount.textContent = String(adults);
    if (dom.childrenCount) dom.childrenCount.textContent = String(children);

    if (dom.adultsDec) dom.adultsDec.disabled = adults <= 1;
    if (dom.childrenDec) dom.childrenDec.disabled = children <= 0;

    const isAtCapacity = total >= maxCapacity;
    if (dom.adultsInc) dom.adultsInc.disabled = isAtCapacity;
    if (dom.childrenInc) dom.childrenInc.disabled = isAtCapacity;
  };

  const formatHumanDate = (date) => {
    if (!date) return 'Select date';
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const handleDatesChanged = (checkIn, checkOut) => {
    if (!checkIn && !checkOut) {
      activeReservation = null;
    }

    if (dom.previewCheckin) dom.previewCheckin.textContent = formatHumanDate(checkIn);
    if (dom.previewCheckout) dom.previewCheckout.textContent = formatHumanDate(checkOut);

    if (dom.btnResetDates) {
      dom.btnResetDates.hidden = !checkIn && !checkOut;
    }

    if (checkIn && !checkOut) {
      if (dom.statusNotice) {
        dom.statusNotice.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
          <span>Check-in selected (${formatHumanDate(checkIn)}). Now select your check-out date.</span>
        `;
      }
      if (dom.priceBreakdown) dom.priceBreakdown.hidden = true;
      if (dom.btnOpenInquiry) dom.btnOpenInquiry.disabled = true;
      currentQuote = null;
      return;
    }

    if (!checkIn && !checkOut) {
      if (dom.statusNotice) {
        dom.statusNotice.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
          <span>Please select your check-in and check-out dates on the calendar.</span>
        `;
      }
      if (dom.priceBreakdown) dom.priceBreakdown.hidden = true;
      if (dom.btnOpenInquiry) dom.btnOpenInquiry.disabled = true;
      currentQuote = null;
      return;
    }

    recalculateQuote();
  };

  const recalculateQuote = () => {
    const { checkIn, checkOut } = CalendarEngine.getDates();
    if (!checkIn || !checkOut) return;

    currentQuote = BookingAPI.calculateQuote(checkIn, checkOut, adults, children);
    if (!currentQuote) return;

    if (!currentQuote.isMinNightsMet) {
      if (dom.statusNotice) {
        dom.statusNotice.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#C86D46" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
          <span style="color:#C86D46; font-weight:600;">Minimum stay is ${currentQuote.minNights} nights. Selected stay is ${currentQuote.nights} night.</span>
        `;
      }
      if (dom.priceBreakdown) dom.priceBreakdown.hidden = true;
      if (dom.btnOpenInquiry) dom.btnOpenInquiry.disabled = true;
      return;
    }

    if (dom.priceBreakdown) dom.priceBreakdown.hidden = false;
    if (dom.nightsCount) dom.nightsCount.textContent = String(currentQuote.nights);
    if (dom.rateLine) {
      dom.rateLine.innerHTML = `₱${currentQuote.nightlyRate.toLocaleString()} &times; ${currentQuote.nights} nights`;
    }
    if (dom.subtotalVal) {
      dom.subtotalVal.textContent = `₱${currentQuote.accommodationSubtotal.toLocaleString()}`;
    }
    if (dom.serviceFeeVal) {
      dom.serviceFeeVal.textContent = `₱${currentQuote.serviceFee.toLocaleString()}`;
    }
    if (dom.totalVal) {
      dom.totalVal.textContent = `₱${currentQuote.totalEstimate.toLocaleString()}`;
    }

    if (dom.statusNotice) {
      dom.statusNotice.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8A927D" stroke-width="2" aria-hidden="true"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>
        <span style="color:var(--color-text-main); font-weight:500;">Dates are available for your stay (${currentQuote.nights} nights).</span>
      `;
    }

    if (dom.btnOpenInquiry) dom.btnOpenInquiry.disabled = false;
  };

  const openInquiryModal = () => {
    const { checkIn, checkOut } = CalendarEngine.getDates();
    if (!checkIn || !checkOut || !currentQuote) return;

    if (dom.modalSummaryDates) {
      dom.modalSummaryDates.textContent = `${formatHumanDate(checkIn)} \u2013 ${formatHumanDate(checkOut)}`;
    }
    if (dom.modalSummaryNights) {
      dom.modalSummaryNights.textContent = `${currentQuote.nights} Nights`;
    }
    if (dom.modalSummaryGuests) {
      dom.modalSummaryGuests.textContent = `${adults} Adult${adults > 1 ? 's' : ''}${children > 0 ? `, ${children} Child${children > 1 ? 'ren' : ''}` : ''}`;
    }
    if (dom.modalSummaryPrice) {
      dom.modalSummaryPrice.textContent = `₱${currentQuote.totalEstimate.toLocaleString()} PHP`;
    }

    if (dom.formFeedback) {
      dom.formFeedback.hidden = true;
      dom.formFeedback.textContent = '';
    }

    const activeDateKey = `${CalendarEngine.formatDateKey(checkIn)}_${CalendarEngine.formatDateKey(checkOut)}`;
    const hasAlreadyBooked = activeReservation && activeReservation.dateKey === activeDateKey;

    if (hasAlreadyBooked) {
      // If a booking request has already been made for these dates, show ONLY the success state
      if (dom.modalHeader) dom.modalHeader.hidden = true;
      if (dom.inquirySummary) dom.inquirySummary.hidden = true;
      if (dom.inquiryForm) dom.inquiryForm.hidden = true;
      if (dom.inquirySuccess) dom.inquirySuccess.hidden = false;
    } else {
      // Normal booking inquiry form state
      if (dom.modalHeader) dom.modalHeader.hidden = false;
      if (dom.inquirySummary) dom.inquirySummary.hidden = false;
      if (dom.inquiryForm) dom.inquiryForm.hidden = false;
      if (dom.inquirySuccess) dom.inquirySuccess.hidden = true;
    }

    lastFocusedTrigger = document.activeElement;

    if (dom.inquiryModal) {
      dom.inquiryModal.hidden = false;
      document.body.style.overflow = 'hidden';
      stopScroll();

      if (hasAlreadyBooked) {
        if (dom.inquiryFinish) dom.inquiryFinish.focus();
      } else {
        const firstInput = dom.inquiryForm ? dom.inquiryForm.querySelector('input') : null;
        if (firstInput) firstInput.focus();
      }
    }
  };

  const closeInquiryModal = () => {
    if (dom.inquiryModal) dom.inquiryModal.hidden = true;
    document.body.style.overflow = '';
    startScroll();

    if (lastFocusedTrigger && typeof lastFocusedTrigger.focus === 'function') {
      lastFocusedTrigger.focus();
    }
  };

  const handleInquirySubmit = async (e) => {
    e.preventDefault();

    const nameInput = document.getElementById('guest-name');
    const emailInput = document.getElementById('guest-email');
    const phoneInput = document.getElementById('guest-phone');
    const notesInput = document.getElementById('guest-notes');
    const policyInput = document.getElementById('policy-agree');

    if (
      !nameInput.value.trim() ||
      !emailInput.value.trim() ||
      !phoneInput.value.trim() ||
      !policyInput.checked
    ) {
      dom.formFeedback.hidden = false;
      dom.formFeedback.className = 'form-feedback form-feedback--error';
      dom.formFeedback.textContent =
        'Please complete all required fields and accept the inquiry policy.';
      return;
    }

    const submitBtn = document.getElementById('inquiry-submit');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="btn__text">Transmitting Request...</span>';
    }

    try {
      const selectedPaymentRadio = document.querySelector('input[name="payment_method"]:checked');
      const selectedPayment = selectedPaymentRadio ? selectedPaymentRadio.value : 'credit_card';
      const paymentMethodLabel = selectedPayment === 'gcash'
        ? 'GCash Express (Mock Simulation)'
        : 'Visa / Mastercard (Mock Simulation)';

      const { checkIn, checkOut } = CalendarEngine.getDates();
      const response = await startBookingCheckout({
        checkIn: CalendarEngine.formatDateKey(checkIn),
        checkOut: CalendarEngine.formatDateKey(checkOut),
        adults,
        children,
        paymentMethod: selectedPayment,
        guest: {
          name: nameInput.value.trim(),
          email: emailInput.value.trim(),
          phone: phoneInput.value.trim(),
          notes: notesInput ? notesInput.value.trim() : '',
        },
        quote: currentQuote,
      });

      if (response && response.checkoutUrl) {
        window.location.href = response.checkoutUrl;
        return;
      }

      // Save active reservation state so reopening this date selection remembers the confirmation
      const activeDateKey = `${CalendarEngine.formatDateKey(checkIn)}_${CalendarEngine.formatDateKey(checkOut)}`;
      activeReservation = {
        dateKey: activeDateKey,
        referenceId: response.referenceId || 'MA-AZUR',
        guestName: nameInput.value.trim(),
        datesText: `${formatHumanDate(checkIn)} \u2013 ${formatHumanDate(checkOut)}`,
        nightsText: `${currentQuote.nights} Night${currentQuote.nights > 1 ? 's' : ''}`,
        guestsText: `${adults} Adult${adults > 1 ? 's' : ''}${children > 0 ? `, ${children} Child${children > 1 ? 'ren' : ''}` : ''}`,
        priceText: `₱${currentQuote.totalEstimate.toLocaleString()} PHP`,
        paymentMethodText: paymentMethodLabel,
      };

      // Populate success details
      if (dom.successReferenceId) dom.successReferenceId.textContent = activeReservation.referenceId;
      if (dom.successGuestName) dom.successGuestName.textContent = activeReservation.guestName;
      if (dom.successDates) dom.successDates.textContent = activeReservation.datesText;
      if (dom.successNights) dom.successNights.textContent = activeReservation.nightsText;
      if (dom.successGuests) dom.successGuests.textContent = activeReservation.guestsText;
      if (dom.successPrice) dom.successPrice.textContent = activeReservation.priceText;
      if (dom.successPayment) dom.successPayment.textContent = activeReservation.paymentMethodText;

      // Remove / hide everything else in the modal:
      if (dom.modalHeader) dom.modalHeader.hidden = true;
      if (dom.inquirySummary) dom.inquirySummary.hidden = true;
      if (dom.inquiryForm) {
        dom.inquiryForm.hidden = true;
        dom.inquiryForm.reset();
      }

      // Show ONLY the success state
      if (dom.inquirySuccess) dom.inquirySuccess.hidden = false;
      if (dom.inquiryFinish) dom.inquiryFinish.focus();

      // Re-fetch live availability so newly booked dates are locked immediately in the calendar grid
      await BookingAPI.fetchAvailability();
      CalendarEngine.render();
    } catch (err) {
      console.error('[BookingController] Reservation error:', err);
      if (dom.formFeedback) {
        dom.formFeedback.hidden = false;
        dom.formFeedback.className = 'form-feedback form-feedback--error';
        dom.formFeedback.textContent =
          err.message || 'The selected dates are no longer available. Please select another date range.';
      }
      // Re-fetch availability to immediately show newly blocked dates in the calendar grid
      await BookingAPI.fetchAvailability();
      CalendarEngine.render();
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span class="btn__text">Send Booking Request</span>';
      }
    }
  };

  return { init };
})();

export function initCalendarAndBooking() {
  BookingController.init();
}
