using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Data;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace bitmap
{
    public partial class Form1 : Form
    {
        // A* algorithm
        //use map and go in a direction to identify a wall, if there is a wall cannot try that direction again
        // end points and start points
        [DllImport("user32.dll")]
        public static extern int SetActiveWindow(IntPtr hwnd);
        [DllImport("user32.dll")]
        public static extern int SetForegroundWindow(IntPtr hwnd);
        //
        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
        //
        [DllImport("user32.dll")]
        static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        [DllImport("user32.dll", CharSet = CharSet.Auto, CallingConvention = CallingConvention.StdCall)]
        public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);

        [DllImport("user32.dll", EntryPoint = "SetCursorPos")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetCursorPos(int x, int y);
        //Mouse actions & Fkeys
        

        private const int MOUSEEVENTF_LEFTDOWN = 0x02;
        private const int MOUSEEVENTF_LEFTUP = 0x04;
        private const int MOUSEEVENTF_RIGHTDOWN = 0x08;
        private const int MOUSEEVENTF_RIGHTUP = 0x10;
        private const int WM_KEYDOWN = 0x0100;
        private const int VK_F1 = 0x70;
        private const int VK_1 = 0x31;
        private const int VK_F2 = 0x71;
        private const int VK_F3 = 0x72;
        private const int VK_F4 = 0x73;
        private const int VK_F5 = 0x74;
        private const int VK_F6 = 0x75;
        private const int VK_F7 = 0x76;
        private const int VK_F8 = 0x77;
        private const int VK_F9 = 0x78;
        private const int VK_F10 = 0x79;
        private const int VK_F11 = 0x7A;
        private const int VK_F12 = 0x7B;



        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;        // x position of upper-left corner
            public int Top;         // y position of upper-left corner
            public int Right;       // x position of lower-right corner
            public int Bottom;      // y position of lower-right corner
        }


        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr FindWindowEx(IntPtr parentHandle, IntPtr childAfter, string lclassName, string windowTitle);
       
        public static IntPtr HWND;
        public static Process OwnerProcess;
        public static RECT RT;
        public Rectangle MyRect = new Rectangle();
        public double MinDistance;
        public Pixel MinCoord;
        public RECT rt;
        public Bitmap OverallScreenBitmap;
        public List<Pixelcolor> PixelColorList = new List<Pixelcolor>();
        public List<Pixel> MonsterPixelList = new List<Pixel>();
        public Pixel Character;
        public Form1()
        {
            InitializeComponent();

          
        }

        private void button1_Click(object sender, EventArgs e)
        {
            List<Pixel> pixelList = new List<Pixel>();
            //Set stop watches to time buffs/TT
            var stopwatch = Stopwatch.StartNew();
            var gameStopwatch = Stopwatch.StartNew();
            gameStopwatch.Start();

            //Find handle & handle info
            HWND = FindWindowEx(IntPtr.Zero, IntPtr.Zero, null,"Legend of Mir III - Xtreme Edition");

            GetWindowRect(HWND, out rt);

            MyRect.X = rt.Left;
            MyRect.Y = rt.Top;
            MyRect.Width = rt.Right - rt.Left;
            MyRect.Height = rt.Bottom - rt.Top;

            bool Isplayed = true;
            int counter = 0;
            do
            {
                MakeBitmap();
                LockandReadImage(OverallScreenBitmap); // also attacks for now
                if (stopwatch.IsRunning == false || stopwatch.ElapsedMilliseconds > 180000 )
                {
                    CastBuffs();
                    UseRT();
                    stopwatch.Restart();
                    stopwatch.Start();

                }
                if( counter % 20 == 0)
                {
                    PickUpItems();
                }
                counter++;
                if (gameStopwatch.ElapsedMilliseconds > 7.2e+6) 
                {                                     
                    Isplayed = false;
                }



            } while (Isplayed == true);


        }



        public void UseRT()
        {
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_1, IntPtr.Zero);
         
        }
        public void CastBuffs()
        {
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F2, IntPtr.Zero);
            System.Threading.Thread.Sleep(1500);
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F3, IntPtr.Zero);
            System.Threading.Thread.Sleep(1500);
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F4, IntPtr.Zero);
            System.Threading.Thread.Sleep(1500);
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F5, IntPtr.Zero);

        }
        private void PickUpItems()
        {
            DoMouseClick(MyRect.X + 8 + Character.X, 31 + MyRect.Y + Character.Y);
            DoMouseClick(MyRect.X + 8 + Character.X, 31 + MyRect.Y + Character.Y);
            DoMouseClick(MyRect.X + 8 + Character.X, 31 + MyRect.Y + Character.Y);
            DoMouseClick(MyRect.X + 8 + Character.X, 31 + MyRect.Y + Character.Y);
        }

        public void DoMouseClick(int X, int Y)
        {
            //Call the imported function with the cursor's current position
            SetCursorPos(X, Y);
            //SetForegroundWindow(HWND);
            mouse_event(MOUSEEVENTF_LEFTDOWN, (uint)X, (uint)Y, 0, 0);
            System.Threading.Thread.Sleep(100);
            mouse_event(MOUSEEVENTF_LEFTUP, (uint)X, (uint)Y, 0, 0);

        }


        public void MakeBitmap()
        {
            //Create a new bitmap.
            // bmpScreenshot = new Bitmap(MyRect.Width, MyRect.Height);
            OverallScreenBitmap = new Bitmap(1600, 900);

            // Create a graphics object from the bitmap.
            var gfxScreenshot = Graphics.FromImage(OverallScreenBitmap);

            // Take the screenshot from the upper left corner to the right bottom corner.
            gfxScreenshot.CopyFromScreen(rt.Left+8,
                                        rt.Top+31,
                                        0,
                                        0,
                                        new Rectangle(0,0,1600,900).Size,
                                        CopyPixelOperation.SourceCopy);

        }

        public unsafe void LockandReadImage(Bitmap bmpScreenshot)
        {
            MonsterPixelList.Clear();
            BitmapData bData = new BitmapData();

            bData = bmpScreenshot.LockBits(new Rectangle(0, 0, bmpScreenshot.Width, bmpScreenshot.Height), ImageLockMode.ReadWrite, bmpScreenshot.PixelFormat);

            byte bitsPerPixel = (byte)Bitmap.GetPixelFormatSize(bData.PixelFormat);

            /*This time we convert the IntPtr to a ptr*/
            byte* scan0 = (byte*)bData.Scan0.ToPointer();

            for (int i = 0; i < bData.Height - 100; ++i)
            {
                for (int j = 0; j < bData.Width - 1; ++j)
                {


                    // Look for 3 black pixels in a colum next to a white
                    byte* color = scan0 + i * bData.Stride + j * bitsPerPixel / 8;
                    byte* color1 = scan0 + (i + 1) * bData.Stride + j * bitsPerPixel / 8;
                    byte* color2 = scan0 + (i + 1) * bData.Stride + j * bitsPerPixel / 8;
                    byte* color3 = scan0 + i * bData.Stride + (j + 1) * bitsPerPixel / 8;

                    if (color[0] == color[1] && color[0] == color[2] && color[0] == 0 && color1[0] == color1[1] && color1[0] == color1[2] && color1[0] == 0 && color2[0] == color2[1] && color2[0] == color2[2] && color2[0] == 0 && color3[0] == color3[1] && color3[0] == color3[2] && color3[0] > 100)
                    {
                        MonsterPixelList.Add(new Pixel(j, i));   
                    }

                    //data is a pointer to the first byte of the 3-byte color data
                    //data[0] = blueComponent;
                    //data[1] = greenComponent;
                    //data[2] = redComponent;
                    
                }
            }

            bmpScreenshot.UnlockBits(bData);
            Character = new Pixel(bmpScreenshot.Width / 2, bmpScreenshot.Height / 2);
            MinDistance = 100000000;
            foreach (var pixel in MonsterPixelList)
            {
                double dist = Math.Sqrt(Math.Pow(Character.X - pixel.X, 2) + Math.Pow(Character.Y - pixel.Y, 2));
                if (dist < MinDistance && dist > 50)
                {
                    MinDistance = dist;
                    MinCoord = pixel;
                }
            }

            DoMouseClick(MinCoord.X + MyRect.X + 8, MinCoord.Y + MyRect.Y + 31);


        }



    }


   
    public class Pixel
    {
        public Pixel(int x, int y)
        {
            X = x;
            Y = y;
        }

        public int X { get; set; }
        public int Y { get; set; }
    }

    public class Pixelcolor
    {
        public Pixelcolor(byte b, byte g, byte r)
        {
            B = b;
            G = g;
            R = r;
        }

        public byte B { get; set; }
        public byte G { get; set; }
        public byte R { get; set; }
    }

 
}
