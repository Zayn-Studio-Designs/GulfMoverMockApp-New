import '@testing-library/jest-dom';

// jsdom does not implement scrolling.
window.scrollTo = () => {};
Element.prototype.scrollIntoView = () => {};
