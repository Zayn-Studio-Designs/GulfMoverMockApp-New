import { createContext, useContext, useState } from 'react';

interface DemoContextProps {
  demoMode: boolean;
  resetDemoData: () => void;
  sampleData: any;
}

const DemoContext = createContext<DemoContextProps | undefined>(undefined);

export const useDemo = () => {
  const context = useContext(DemoContext);
  if (!context) {
    throw new Error('useDemo must be used within a DemoProvider');
  }
  return context;
};

export const DemoProvider = ({ children }: { children: React.ReactNode }) => {
  const [demoMode, setDemoMode] = useState(true);
  const [sampleData, setSampleData] = useState<any>({});

  const resetDemoData = () => {
    // Reset to initial sample data
    setSampleData({
      bookings: [],
      sailings: [],
      organizations: [],
      materials: []
    });
  };

  // Initialize sample data
  useEffect(() => {
    resetDemoData();
  }, []);

  return (
    <DemoContext.Provider value={{ demoMode, resetDemoData, sampleData }}>
      {children}
    </DemoContext.Provider>
  );
};

export default DemoContext;